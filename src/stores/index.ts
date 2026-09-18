import { create } from 'zustand'
import type { HarnessConfig } from '../../shared/config'
import { BASE_CONFIG } from '../../shared/config'
import type { HarnessEvent, ReplayMeta, ScenarioMeta } from '../../shared/events'
import { api, type ForgeData, type ForgeGen, type ScenarioSummary } from '../api'
import { deriveRun, type DerivedRun } from '../lib/derive'
import type { PresetVariant } from '../../shared/presets'

// ---------- Global: scenario catalog ----------
interface AppState {
  ready: boolean
  online: boolean
  scenarios: ScenarioSummary[]
  metas: Record<string, ScenarioMeta>
  current: string
  forge: ForgeData | null
  bootstrap: () => Promise<void>
  select: (id: string) => void
}
export const useApp = create<AppState>((set, get) => ({
  ready: false,
  online: false,
  scenarios: [],
  metas: {},
  current: '',
  forge: null,
  async bootstrap() {
    try {
      const scenarios = await api.scenarios()
      const metas: Record<string, ScenarioMeta> = {}
      for (const s of scenarios) metas[s.scenarioId] = await api.scenario(s.scenarioId)
      const forge = await api.forge()
      set({ ready: true, online: true, scenarios, metas, forge, current: get().current || scenarios[0]?.scenarioId || '' })
    } catch {
      set({ ready: true, online: false })
    }
  },
  select(id) { set({ current: id }) },
}))

// ---------- MRI: replay ----------
interface RunState {
  run: DerivedRun | null
  meta: ReplayMeta | null
  loading: boolean
  error: string | null
  playhead: number // number of events played
  playing: boolean
  speed: number
  load: (scenarioId: string, branchId: string) => Promise<void>
  setPlayhead: (n: number) => void
  setPlaying: (b: boolean) => void
  setSpeed: (n: number) => void
  tick: () => void
}
export const useRun = create<RunState>((set, get) => ({
  run: null, meta: null, loading: false, error: null, playhead: 0, playing: false, speed: 1,
  async load(scenarioId, branchId) {
    set({ loading: true, error: null, playhead: 0, playing: false })
    try {
      const { meta, events } = await api.replayBranch(scenarioId, branchId)
      set({ run: deriveRun(events as HarnessEvent[]), meta, loading: false })
    } catch (e) {
      set({ loading: false, error: String(e) })
    }
  },
  setPlayhead: (n) => set((s) => ({ playhead: Math.max(0, Math.min(n, s.run?.events.length ?? 0)) })),
  setPlaying: (b) => set({ playing: b }),
  setSpeed: (n) => set({ speed: n }),
  tick() {
    const { playhead, run } = get()
    if (!run) return
    if (playhead >= run.events.length) { set({ playing: false }); return }
    set({ playhead: playhead + 1 })
  },
}))

// ---------- Wind Tunnel: config & variants ----------
export interface Variant {
  key: string
  label: string
  config: HarnessConfig
  branchId?: string
  note?: string
  color: string
}
export interface VariantMetrics {
  successRate: number
  tokens: number
  latencyP50: number
  failureModes: Record<string, number>
  source: { kind: string; label: string; citation?: string }
  exact: boolean
  distance?: number
  /** Per-run scorecard success rates backing F2-6 lower-tail stats. */
  runs?: number[]
}
interface TunnelState {
  scenarioId: string
  config: HarnessConfig
  variants: Variant[]
  metrics: Record<string, VariantMetrics>
  fetching: string | null
  /** Locked baseline variant key for F2-2 (null = first row acts as baseline). */
  lockedKey: string | null
  lockBaseline: (key: string) => void
  setScenario: (id: string) => void
  loadBranchConfig: (scenarioId: string, branchId: string) => void
  setField: (f: keyof HarnessConfig, v: string) => void
  addVariant: (label: string, config: HarnessConfig, branchId?: string, note?: string) => void
  removeVariant: (key: string) => void
  clearVariants: () => void
  resetBoard: () => void
  loadPresetVariants: (scenarioId: string, list: PresetVariant[]) => void
  fetchMetrics: () => Promise<void>
}
const COLORS = ['#22d3ee', '#34d399', '#fbbf24', '#f87171', '#a78bfa', '#60a5fa']
let vseq = 0
export const useTunnel = create<TunnelState>((set, get) => ({
  scenarioId: '',
  config: { ...BASE_CONFIG },
  variants: [],
  metrics: {},
  fetching: null,
  lockedKey: null,
  lockBaseline(key) { set({ lockedKey: key }) },
  setScenario(id) {
    set({ scenarioId: id, variants: [], metrics: {}, config: { ...BASE_CONFIG }, lockedKey: null })
    void get().fetchMetrics()
  },
  loadBranchConfig(scenarioId, branchId) {
    const meta = useApp.getState().metas[scenarioId]
    const branch = meta?.branches.find((b) => b.branchId === branchId)
    if (!branch) return
    // Only sync the board draft — never drop the user's added variants.
    // Variants belong to a scenario; clear them only when the scenario actually changes.
    if (get().scenarioId !== scenarioId) {
      set({ scenarioId, config: { ...branch.config }, variants: [], metrics: {} })
    } else {
      set({ config: { ...branch.config } })
    }
  },
  setField(f, v) { set((s) => ({ config: { ...s.config, [f]: v } })) },
  addVariant(label, config, branchId, note) {
    const key = `v${++vseq}`
    set((s) => ({ variants: [...s.variants, { key, label, config, branchId, note, color: COLORS[s.variants.length % COLORS.length] }] }))
    void get().fetchMetrics()
  },
  removeVariant(key) { set((s) => ({ variants: s.variants.filter((v) => v.key !== key) })) },
  clearVariants() { set({ variants: [], metrics: {} }) },
  resetBoard() { set({ config: { ...BASE_CONFIG } }) },
  loadPresetVariants(scenarioId, list) {
    // Atomic: single set + single fetch. Previously clear + N appends fired
    // fetchMetrics on stale snapshots, and the scenarioId lag let the screen
    // effect wipe freshly added variants when switching scenarios.
    const vs: Variant[] = list.map((v, i) => ({ key: `v${++vseq}`, label: v.label, config: v.config, branchId: v.branchId, note: v.note, color: COLORS[i % COLORS.length] }))
    set({ scenarioId, variants: vs, metrics: {}, fetching: null, lockedKey: null })
    void get().fetchMetrics()
  },
  async fetchMetrics() {
    const { scenarioId, variants, metrics } = get()
    if (!scenarioId) return
    for (const v of variants) {
      if (metrics[v.key]) continue
      set({ fetching: v.key })
      try {
        const r = await api.metrics(scenarioId, v.config) as { entry: import('../../shared/events').MetricsEntry; exact: boolean; distance?: number }
        set((s) => ({
          metrics: {
            ...s.metrics,
            [v.key]: {
              successRate: r.entry.successRate, tokens: r.entry.tokens, latencyP50: r.entry.latencyP50,
              failureModes: r.entry.failureModes as Record<string, number>, source: r.entry.source,
              exact: r.exact, distance: r.distance, runs: r.entry.runs,
            },
          },
        }))
      } catch {
        set((s) => ({ metrics: { ...s.metrics, [v.key]: { successRate: 0, tokens: 0, latencyP50: 0, failureModes: {}, source: { kind: 'fixture', label: 'Fetch Failed' }, exact: false } } }))
      }
    }
    set({ fetching: null })
  },
}))

// ---------- Forge ----------
interface ForgeState {
  currentGen: number
  decisions: Record<number, 'approved' | 'rejected'>
  /** Gens whose effective decision came from the autonomy policy (not a human click). Cleared on manual override / reset. */
  autoDecided: Record<number, true>
  /** 0 = stop at every gen, 1 = pause only on high-risk gens, 2 = run through on pipeline verdicts. Default 0 = legacy behavior. */
  autonomy: number
  autoplay: boolean
  /** Gen where autoplay last halted awaiting a human decision (null = running / never halted / human acted since). */
  haltedAt: number | null
  autoplayTo: (n: number) => void
  setGen: (n: number) => void
  setAutonomy: (n: number) => void
  decide: (gen: number, d: 'approved' | 'rejected') => void
  reset: () => void
}
export const useForge = create<ForgeState>((set, get) => ({
  currentGen: 1,
  decisions: {},
  autoDecided: {},
  autonomy: 0,
  autoplay: false,
  haltedAt: null,
  autoplayTo(n) { set({ autoplay: true, haltedAt: null }); void stepTo(n) },
  setGen(n) { set({ currentGen: n, autoplay: false, haltedAt: null }) },
  setAutonomy(n) { set({ autonomy: Math.max(0, Math.min(2, Math.round(n))) }) },
  decide(gen, d) {
    set((s) => {
      const autoDecided = { ...s.autoDecided }
      delete autoDecided[gen] // human click always wins over policy
      return { decisions: { ...s.decisions, [gen]: d }, autoDecided, haltedAt: null }
    })
  },
  reset: () => set({ currentGen: 1, decisions: {}, autoDecided: {}, autoplay: false, haltedAt: null }),
}))

/** Seams whose blast radius demands a human even when falsification looks clean. */
const HIGH_BLAST_SEAMS = new Set(['① Loop Control Flow', '⑬ Feedback Sensors & Lints'])

/** L0: nothing auto. L1: safe cards only (no regressions + narrow seam). L2: all pipeline verdicts. */
function policyAllows(autonomy: number, gen: ForgeGen): boolean {
  if (autonomy <= 0) return false
  if (autonomy >= 2) return true
  return gen.falsification.regressed === 0 && !HIGH_BLAST_SEAMS.has(gen.card.seam)
}

let stepTimer: ReturnType<typeof setInterval> | null = null
async function stepTo(target: number) {
  if (stepTimer) clearInterval(stepTimer)
  const stop = () => { useForge.setState({ autoplay: false }); if (stepTimer) clearInterval(stepTimer) }
  stepTimer = setInterval(() => {
    const s = useForge.getState()
    const forge = useApp.getState().forge
    if (!forge || s.currentGen > forge.gens.length) { stop(); return }
    const done = s.currentGen >= target
    if (!s.decisions[s.currentGen]) {
      const gen = forge.gens.find((g) => g.gen === s.currentGen)
      if (gen && policyAllows(s.autonomy, gen)) {
        useForge.setState((st) => ({ decisions: { ...st.decisions, [gen.gen]: gen.verdict }, autoDecided: { ...st.autoDecided, [gen.gen]: true } }))
      } else {
        // Gate stop: record WHERE and stay silent about nothing — the UI explains why.
        useForge.setState({ autoplay: false, haltedAt: s.currentGen })
        if (stepTimer) clearInterval(stepTimer)
        return
      }
    }
    if (done) { stop(); return } // stay on the final gen; detail panel keeps showing it
    useForge.setState({ currentGen: s.currentGen + 1 })
  }, 700)
}

// ---------- Demo ----------
interface DemoState { step: number; next: () => void; prev: () => void; setStep: (n: number) => void }
export const useDemo = create<DemoState>((set) => ({
  step: 0,
  next: () => set((s) => ({ step: Math.min(s.step + 1, 11) })),
  prev: () => set((s) => ({ step: Math.max(s.step - 1, 0) })),
  setStep: (n) => set({ step: n }),
}))
