// M4 PRISM orchestration (design §7.2): deterministic clustering → routing →
// LLM-in-surface proposals → multi-candidate repair screen → top-2 gate
// (×repeats) → Pareto pick → approval gate → immutable version tree.
import { PG_PRESETS } from './presets'
import { getRunDetail, listRuns } from './liveDb'
import {
  currentGeneration,
  getCluster,
  getGeneration,
  getMutation,
  insertCluster,
  insertGeneration,
  insertMutation,
  listCards,
  listClusters,
  listGenerations,
  listMutations,
  setCurrentGeneration,
  updateCardStatus,
  updateCardFalsification,
  updateMutationGate,
  kvGetJson,
  kvSetJson,
} from './evoDb'
import { clusterRuns } from './cluster'
import { buildCardsForCluster } from './cardFactory'
import {
  applyCardToConfig,
  falsifyCard,
  falsificationPasses,
  gateVerify,
  gateVerifyConfigs,
  gateRepeatsFor,
} from './falsifier'
import { paretoFrontier, pickParetoWinner } from './gainEstimator'
import { fingerprint, type HarnessConfig } from '../../shared/config'
import type {
  ChangeCard,
  EvoAnalysis,
  EvoCluster,
  EvoGeneration,
  EvoProfile,
  EvoMutation,
  EvoRace,
  EvoRaceEntry,
  EvoRaceJob,
  FalsificationResult,
  GateResult,
  GateStatus,
  PgMounts,
  RunDetail,
} from '../../shared/playground'
import { EVO_PROFILES } from '../../shared/playground'

const now = () => new Date().toISOString()
/**
 * Identity of this server process. Detached evolution jobs live in-process, so
 * a row written by an earlier boot can never finish — stamped on every job so
 * `staleGuard` can tell "still running" from "already dead".
 */
export const BOOT_ID = `boot_${process.pid}_${Date.now().toString(36)}`
const genId = () => `gen_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
const commitId = () => `commit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`

/** §7.2④ / §3.7: at most this many repair-screen survivors advance to gate. */
export const TOP_N_GATE = 2

function scoredLiveRepairRuns(): RunDetail[] {
  const summaries = listRuns({ limit: 5000, source: 'live' }).filter(
    (r) => r.status === 'scored' && r.split === 'repair',
  )
  const details = summaries.map((r) => getRunDetail(r.runId)).filter((r): r is RunDetail => !!r)
  return details
}

function dominantFingerprint(runs: RunDetail[]): { config: HarnessConfig; mounts: PgMounts; fingerprint: string } {
  if (runs.length) {
    const tally = new Map<string, number>()
    for (const r of runs) tally.set(r.fingerprint, (tally.get(r.fingerprint) ?? 0) + 1)
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    const rep = runs.find((r) => r.fingerprint === best)
    if (rep) return { config: rep.config, mounts: rep.mounts, fingerprint: rep.fingerprint }
  }
  const c0 = PG_PRESETS[0]!
  return { config: { ...c0.config }, mounts: { ...c0.mounts }, fingerprint: fingerprint(c0.config) }
}

/** Seed / return the current evolving generation (the parent for new cards). */
export function ensureBaseGeneration(runs: RunDetail[]): EvoGeneration {
  const cur = currentGeneration()
  if (cur) return cur
  const base = dominantFingerprint(runs)
  const gen: EvoGeneration = {
    generationId: genId(),
    parentId: null,
    label: 'Evolution baseline (current run config)',
    fingerprint: base.fingerprint,
    config: base.config,
    mounts: base.mounts,
    createdAt: now(),
    source: 'base',
    cardId: null,
  }
  insertGeneration(gen)
  setCurrentGeneration(gen.generationId)
  return gen
}

/**
 * Step ①–③: cluster failed repair runs, route each, and generate cards.
 * When runIds is omitted, uses all scored live repair runs.
 */
export async function analyze(runIds?: string[]): Promise<EvoAnalysis> {
  const all = scoredLiveRepairRuns()
  const pool = runIds && runIds.length ? all.filter((r) => runIds.includes(r.runId)) : all
  const failedAll = pool.filter((r) => r.success === false)
  if (failedAll.length === 0) {
    return { clusters: [], cards: [], note: 'No failed repair runs — nothing to attribute.' }
  }

  const base = ensureBaseGeneration(pool)
  // Evolution acts on one baseline at a time: only cluster failed runs whose
  // config matches the current generation (otherwise a task that already failed
  // under a stricter config would muddle the paired rescue signal).
  const failed = failedAll.filter((r) => r.fingerprint === base.fingerprint)
  if (failed.length === 0) {
    return { clusters: [], cards: [], note: 'No failed runs under the current baseline config; failures from other configs are already avoided at this version.' }
  }
  const clusters = clusterRuns(failed)
  for (const c of clusters) insertCluster(c)

  const repairTotal = new Set(all.map((r) => r.taskId)).size
  const cards: ChangeCard[] = []
  for (const cluster of clusters) {
    const clusterRuns = failed.filter((r) => cluster.runIds.includes(r.runId))
    const made = await buildCardsForCluster(cluster, clusterRuns, {
      config: base.config,
      mounts: base.mounts,
      repairTotal,
    })
    cards.push(...made)
  }

  return {
    clusters,
    cards,
    note: cards.length
      ? `Clustered ${clusters.length} failure group(s) and proposed ${cards.length} change card(s). Cards are candidates: they still need real re-run falsification and the approval gate.`
      : null,
  }
}

// ── step ④–⑤: falsify + approve + version tree ─────────────────────────────

export interface ApplyOptions {
  /** 'manual' = human approves; 'auto' = slider gate decides. */
  mode: 'manual' | 'auto'
  /** Slider level 0/1/2 (§7.5). */
  autonomyLevel?: number
  /** Run profile: 'demo' shrinks the real-run sample, 'full' keeps the measured口径. */
  profile?: EvoProfile
}

export interface ApplyResult {
  ok: boolean
  card: ChangeCard
  falsification: FalsificationResult | null
  generation: EvoGeneration | null
  mutation: EvoMutation | null
  approvedBy: 'gate' | 'human' | null
  /** True when falsification was launched as a background job (poll GET /evolve). */
  started?: boolean
  error?: string
}

function requireHumanFor(card: ChangeCard): boolean {
  return card.hardGate || !card.inTable || card.verdict === 'needs-human'
}

/**
 * Kick off a card's falsification+approval as a detached background job.
 * The real re-run fans out over up to SCREEN_LIMIT+GUARD_LIMIT agent tasks and
 * can take several minutes, so we must not hold the HTTP request open: we
 * return immediately with the card in `screening` and the UI polls
 * GET /evolve until the card moves to applied/falsified.
 */
export async function applyCard(cardId: string, opts: ApplyOptions): Promise<ApplyResult> {
  const card = listCards().find((c) => c.cardId === cardId)
  if (!card) return { ok: false, card: null as never, falsification: null, generation: null, mutation: null, approvedBy: null, error: 'Change card not found' }
  if (card.status === 'applied') return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null, error: 'This change card is already applied.' }
  if (card.status === 'screening') return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null, error: 'This card is being falsified by real re-runs; wait for the result.' }

  const level = opts.autonomyLevel ?? 0
  if (opts.mode === 'auto') {
    if (level === 0) return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null, error: 'Slider is at level 0 (all manual) — nothing auto-applies.' }
    if (requireHumanFor(card)) {
      return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null,
        error: !card.inTable ? 'An out-of-table candidate always requires human review.' : 'This seam is a security/legal hard gate and always needs human approval.' }
    }
  }

  updateCardStatus(cardId, 'screening', 'pending')
  void runApplyCard(cardId, opts).catch((e) => {
    console.error('[playground-evolve] apply worker failed', e)
    try { updateCardStatus(cardId, 'falsified', 'falsified') } catch { /* ignore */ }
  })
  return { ok: true, card, falsification: null, generation: null, mutation: null, approvedBy: null, started: true }
}

/** Commit a card that already passed repair screening (and optional gate). */
function commitPassedCard(
  card: ChangeCard,
  falsification: FalsificationResult,
  opts: ApplyOptions,
  gate?: { result: GateResult; status: GateStatus } | null,
): ApplyResult {
  const level = opts.autonomyLevel ?? 0
  const needsHuman = requireHumanFor(card)
  const parent = currentGeneration() ?? ensureBaseGeneration(scoredLiveRepairRuns())
  const cluster = getCluster(card.clusterId)

  if (opts.mode === 'auto' && level === 1 && falsification.regressed.length > 0) {
    updateCardFalsification(card.cardId, 'falsified', 'falsified', falsification)
    return { ok: false, card, falsification, generation: null, mutation: null, approvedBy: null,
      error: 'Level 1 (conditional auto): the re-run regressed, so auto-apply is forbidden.' }
  }

  // Tasks whose re-run produced no answer (provider/network error) carry no
  // signal. Judging the card on the tasks that did answer would let a flaky
  // endpoint decide the verdict, so the card goes back on the table instead of
  // being accepted or falsified. The numbers are still stored for the panel.
  if (falsification.incomplete.length > 0) {
    updateCardFalsification(card.cardId, 'proposed', 'pending', falsification)
    return { ok: false, card, falsification, generation: null, mutation: null, approvedBy: null,
      error: `Inconclusive: ${falsification.incomplete.length} task(s) produced no answer after retries (${falsification.incomplete.join(', ')}). The card stays proposed — re-run verification when the provider is healthy.` }
  }

  if (!falsificationPasses(falsification)) {
    updateCardFalsification(card.cardId, 'falsified', 'falsified', falsification)
    return { ok: false, card, falsification, generation: null, mutation: null, approvedBy: null,
      error: falsification.hardRegressions.length
        ? `Falsified: a deterministic check regressed — ${falsification.hardRegressions.map((h) => h.reason).join('；')} — not committed to the version tree.`
        : falsification.regressed.length
          ? `Falsified: ${falsification.regressed.length} task(s) regressed, net lift ${falsification.netLiftPp}pp — not committed to the version tree.`
          : 'Falsified: no failed task was rescued — not committed to the version tree.' }
  }

  const { config, mounts } = applyCardToConfig(card, parent.config, parent.mounts)
  const generation: EvoGeneration = {
    generationId: genId(),
    parentId: parent.generationId,
    label: card.title,
    fingerprint: fingerprint(config),
    config,
    mounts,
    createdAt: now(),
    source: 'evolve',
    cardId: card.cardId,
  }
  insertGeneration(generation)

  const configDiff: Partial<HarnessConfig> = { ...(card.middlewareDiff ?? {}) }
  if (card.promptDiff?.guideStyle) {
    if (config.guides !== parent.config.guides) configDiff.guides = config.guides
  }
  const approvedBy: 'gate' | 'human' = opts.mode === 'auto' && !needsHuman ? 'gate' : 'human'

  const mutation: EvoMutation = {
    commitId: commitId(),
    cardId: card.cardId,
    clusterId: card.clusterId,
    parentGenerationId: parent.generationId,
    generationId: generation.generationId,
    createdAt: now(),
    configDiff,
    approvedBy,
    autonomyLevel: level,
    falsification,
    gate: gate?.result ?? null,
    gateStatus: gate?.status ?? 'idle',
  }
  insertMutation(mutation)
  setCurrentGeneration(generation.generationId)
  updateCardFalsification(card.cardId, 'applied', 'accepted', falsification)

  if (cluster && falsification.stillFailed.length === 0 && falsification.regressed.length === 0) {
    insertCluster({ ...cluster, status: 'resolved' })
  }

  return { ok: true, card, falsification, generation, mutation, approvedBy }
}

async function runApplyCard(cardId: string, opts: ApplyOptions): Promise<ApplyResult> {
  const card = listCards().find((c) => c.cardId === cardId)
  if (!card) return { ok: false, card: null as never, falsification: null, generation: null, mutation: null, approvedBy: null, error: 'Change card not found' }
  const cluster = getCluster(card.clusterId)
  if (!cluster) return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null, error: 'Failure cluster not found' }

  const level = opts.autonomyLevel ?? 0
  const needsHuman = requireHumanFor(card)

  if (opts.mode === 'auto') {
    if (level === 0) return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null, error: 'Slider is at level 0 (all manual) — nothing auto-applies.' }
    if (needsHuman) {
      return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null,
        error: !card.inTable ? 'An out-of-table candidate always requires human review.' : 'This seam is a security/legal hard gate and always needs human approval.' }
    }
  }

  const parent = currentGeneration() ?? ensureBaseGeneration(scoredLiveRepairRuns())

  const failedRuns = cluster.runIds
    .map((id) => getRunDetail(id))
    .filter((r): r is RunDetail => !!r && r.success === false)
  if (!failedRuns.length) {
    return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null, error: 'This cluster has no failed run available for re-runs.' }
  }
  const passingRuns = scoredLiveRepairRuns().filter(
    (r) => r.success === true && r.fingerprint === parent.fingerprint && !cluster.runIds.includes(r.runId),
  )

  const providerHint = failedRuns[0]?.provider
  updateCardStatus(cardId, 'screening', 'pending')

  const falsification = await falsifyCard({
    card,
    baseConfig: parent.config,
    baseMounts: parent.mounts,
    failedRuns,
    passingRuns,
    provider: { providerId: providerHint?.providerId, model: providerHint?.model },
    profile: opts.profile,
  })
  if ('error' in falsification) {
    updateCardStatus(cardId, 'proposed', 'pending')
    return { ok: false, card, falsification: null, generation: null, mutation: null, approvedBy: null, error: falsification.error }
  }

  return commitPassedCard(card, falsification, opts)
}

/** Roll back to a prior generation by re-pointing the current pointer (no mutation). */
export function rollbackTo(generationId: string): { ok: boolean; error?: string } {
  const gen = listGenerations().find((g) => g.generationId === generationId)
  if (!gen) return { ok: false, error: 'Version not found' }
  setCurrentGeneration(gen.generationId)
  return { ok: true }
}

// ── §7.2④ held-out gate full verification (asynchronous, on demand) ────────

export interface GateVerifyStartOpts {
  repeats?: number
  temperature?: number
  /** Run profile: 'demo' shrinks the held-out sample. */
  profile?: EvoProfile
}

/**
 * Re-run the held-out gate set under both the committed candidate and its
 * parent (×repeats, design §3.2). Launched detached; UI polls mutation.gateStatus.
 */
export function startGateVerify(commitId: string, opts: GateVerifyStartOpts = {}): { ok: boolean; error?: string } {
  const mutation = getMutation(commitId)
  if (!mutation) return { ok: false, error: 'Change record not found' }
  if (mutation.gateStatus === 'running') return { ok: false, error: 'Full gate verification is already running.' }
  const candidate = getGeneration(mutation.generationId)
  const parent = getGeneration(mutation.parentGenerationId)
  if (!candidate || !parent) return { ok: false, error: 'Candidate or baseline version is missing.' }

  updateMutationGate(commitId, null, 'running')
  const providerHint = scoredLiveRepairRuns().slice(-1)[0]
  const temperature = opts.temperature ?? 0.2
  void (async () => {
    try {
      const out = await gateVerify(
        candidate,
        parent,
        { providerId: providerHint?.provider?.providerId, model: providerHint?.provider?.model },
        { repeats: opts.repeats, temperature, profile: opts.profile },
      )
      // A GateResult may itself carry `error` (partial pass: some runs never
      // answered), so discriminate on gateTaskIds — a real result always has it.
      if (!('gateTaskIds' in out)) {
        updateMutationGate(commitId, {
          gateTaskIds: [], baselinePass: 0, candidatePass: 0,
          baselinePassPp: 0, candidatePassPp: 0, gateLiftPp: 0,
          regressed: [], fixed: [], avgTokens: null, avgLatencyMs: null,
          avgCostUsd: null, repeats: 0,
          baselineRunIds: [], newRunIds: [], ranAt: new Date().toISOString(),
          error: out.error,
        }, 'failed')
        return
      }
      // A partial pass still gets a verdict from the pairs that answered; the
      // missing task is recorded on the result, never assumed to pass.
      const passed = out.regressed.length === 0 && out.gateLiftPp >= 0
      updateMutationGate(commitId, out, passed ? 'passed' : 'failed')
    } catch (e) {
      console.error('[playground-evolve] gate verify failed', e)
      updateMutationGate(commitId, null, 'failed')
    }
  })()
  return { ok: true }
}

// ── §7.5 continuous auto-evolution with termination conditions ─────────────

export interface AutoJob {
  running: boolean
  phase: string
  generationsApplied: number
  stopReason: string | null
  lastError: string | null
  updatedAt: string
  /** See shared/playground AutoJob.bootId. */
  bootId?: string
}

const AUTO_JOB_KEY = 'auto_job'
const MAX_AUTO_GENERATIONS = 6
/** §7.5: stop after this many consecutive generations with no positive lift. */
export const NO_LIFT_LIMIT = 2

/** Auto-eligible cards sorted by predicted gain (highest first). */
export function eligibleAutoCards(cards: ChangeCard[], level: number): ChangeCard[] {
  if (level === 0) return []
  return cards
    .filter((c) => c.status === 'proposed' && c.inTable && !c.hardGate && c.verdict !== 'needs-human')
    .sort((a, b) => (b.predictedGainPp ?? 0) - (a.predictedGainPp ?? 0))
}

/** Pick the highest predicted-gain card the slider may auto-apply; null if none. */
export function chooseAutoCard(cards: ChangeCard[], level: number): ChangeCard | null {
  return eligibleAutoCards(cards, level)[0] ?? null
}

/**
 * §7.2④ / §3.7: take up to `n` cards to repair-screen side-by-side before the
 * gate race, highest predicted gain first.
 *
 * Slider 0 races every proposed card — the race only *picks* a winner, it never
 * applies one, so a hard-gate / out-of-table card may still be compared; the
 * pick then waits for a human (§7.5). Slider ≥1 keeps the auto-eligible filter,
 * because there the winner is applied by the gate without a click.
 */
export function chooseRaceCards(cards: ChangeCard[], level: number, n = TOP_N_GATE): ChangeCard[] {
  const pool = level === 0
    ? cards.filter((c) => c.status === 'proposed')
    : eligibleAutoCards(cards, level)
  return [...pool]
    .sort((a, b) => (b.predictedGainPp ?? 0) - (a.predictedGainPp ?? 0))
    .slice(0, Math.max(0, n))
}

/** Back-compatible name used by the auto loop. */
export function chooseTopCards(cards: ChangeCard[], level: number, n = TOP_N_GATE): ChangeCard[] {
  return chooseRaceCards(cards, level, n)
}

/**
 * Which axis the Pareto comparison runs on. USD once the price table covers the
 * model (design §11.2); tokens remain the honest fallback, and 'none' means
 * neither is available so cost cannot separate the candidates.
 */
export function paretoAxisOf(opts: { avgCostUsd?: number | null; avgTokens?: number | null }): 'usd' | 'token' | 'none' {
  if (opts.avgCostUsd != null && Number.isFinite(opts.avgCostUsd)) return 'usd'
  if (opts.avgTokens != null && Number.isFinite(opts.avgTokens)) return 'token'
  return 'none'
}

/**
 * Cost axis for Pareto: prefer USD; fall back to tokens so unpriced models still
 * race. Never Infinity — an infinite cost would knock every candidate out of the
 * frontier filter and leave the race with no winner.
 */
export function paretoCostOf(opts: { avgCostUsd?: number | null; avgTokens?: number | null }): number {
  if (opts.avgCostUsd != null && Number.isFinite(opts.avgCostUsd)) return opts.avgCostUsd
  if (opts.avgTokens != null && Number.isFinite(opts.avgTokens)) return opts.avgTokens
  return 0
}

/** §7.5 termination: this many consecutive non-positive-lift generations stops. */
export function reachedNoLiftStop(streak: number): boolean {
  return streak >= NO_LIFT_LIMIT
}

export function getAutoJob(): AutoJob | null {
  const job = kvGetJson<AutoJob>(AUTO_JOB_KEY)
  if (!job) return null
  return staleGuard(job, { phase: 'Interrupted by a process restart', stopReason: 'The previous self-evolution run died with the server process; start it again.' })
}

function writeAutoJob(patch: Partial<AutoJob>): void {
  const prev = getAutoJob()
  kvSetJson(AUTO_JOB_KEY, {
    running: false,
    phase: '',
    generationsApplied: 0,
    stopReason: null,
    lastError: null,
    updatedAt: now(),
    bootId: BOOT_ID,
    ...prev,
    ...patch,
  } satisfies AutoJob)
}

/**
 * A detached job lives inside this process. If the row says "running" but was
 * written by an earlier process, the work is gone — report it as interrupted
 * instead of leaving the UI polling a job nobody is executing.
 */
export function staleGuard<T extends { running: boolean; bootId?: string }>(
  job: T | null,
  patch: { phase?: string; stopReason?: string | null; lastError?: string | null },
): T | null {
  if (!job) return null
  // Missing bootId means a row written before this guard existed — same fate.
  if (job.running && job.bootId !== BOOT_ID) {
    return { ...job, running: false, ...patch } as T
  }
  return job
}

/**
 * Boot recovery for cards frozen in `screening`.
 *
 * A card enters `screening` and then a detached worker re-runs real tasks for it.
 * That worker lives in this process, so a restart kills it mid-flight and the row
 * stays `screening` forever. `applyCard` refuses to start a card that is already
 * screening, so the panel's button would be permanently dead with no way back
 * except editing SQLite by hand.
 *
 * `screening` is never persisted, so any such row on boot is by definition dead.
 * Put it back to `proposed` — NOT `falsified`: we learned nothing about the
 * candidate, and marking it falsified would be a verdict we never measured.
 */
export function recoverStuckCards(): number {
  const stuck = listCards().filter((c) => c.status === 'screening')
  for (const c of stuck) updateCardStatus(c.cardId, 'proposed', 'pending')
  return stuck.length
}

// ── §7.2④ stand-alone top-N Pareto race (design §10 M4) ────────────────────

const RACE_JOB_KEY = 'race_job'

export function getRaceJob(): EvoRaceJob | null {
  const job = kvGetJson<EvoRaceJob>(RACE_JOB_KEY)
  if (!job) return null
  return staleGuard(job, { phase: 'Interrupted by a process restart', lastError: 'The previous top-N race died with the server process; start it again.' })
}

function writeRaceJob(patch: Partial<EvoRaceJob>): void {
  const prev = kvGetJson<EvoRaceJob>(RACE_JOB_KEY)
  kvSetJson(RACE_JOB_KEY, {
    running: false,
    phase: '',
    race: null,
    lastError: null,
    updatedAt: now(),
    bootId: BOOT_ID,
    ...prev,
    ...patch,
  } satisfies EvoRaceJob)
}

export interface RaceStartOpts {
  autonomyLevel: number
  /** How many cards race side by side (default 2, design §7.2④). */
  topN?: number
  /** §3.2 repeats per (task × config) in the gate pass. */
  repeats?: number
  /** Run profile: 'demo' shrinks the real-run sample. */
  profile?: EvoProfile
}

/**
 * Run the top-N race on demand (the "race" button), detached — a race is
 * topN × gate tasks × repeats × 2 real executions and takes many minutes. The
 * UI polls GET /evolve for `raceJob`.
 */
export function startTopRace(opts: RaceStartOpts): { ok: boolean; error?: string } {
  if (getRaceJob()?.running) return { ok: false, error: 'A top-N race is already running.' }
  if (getAutoJob()?.running) return { ok: false, error: 'Continuous self-evolution is running; wait for it to finish first.' }
  writeRaceJob({ running: true, phase: 'Preparing candidates', race: null, lastError: null })

  void (async () => {
    try {
      let cards = listCards().filter((c) => c.status === 'proposed')
      if (!cards.length) {
        writeRaceJob({ phase: 'Clustering failures (no candidate cards yet)' })
        const analysis = await analyze()
        cards = analysis.cards
      }
      const top = chooseRaceCards(cards, opts.autonomyLevel, opts.topN ?? TOP_N_GATE)
      if (!top.length) {
        writeRaceJob({
          running: false,
          phase: 'No candidates',
          race: {
            raceId: `race_${Date.now().toString(36)}`,
            at: now(),
            topN: opts.topN ?? TOP_N_GATE,
            repeats: gateRepeatsFor(0.2, opts.repeats),
            screened: 0,
            gated: 0,
            entries: [],
            winnerCardId: null,
            awaitingHuman: false,
            applied: false,
            note: 'No candidate card to race (click "Cluster failed runs" first to propose cards).',
          },
        })
        return
      }
      writeRaceJob({ phase: `top-${top.length} race: repair screen → gate×repeats → Pareto` })
      const outcome = await raceTopCards(top, opts.autonomyLevel, {
        repeats: opts.repeats,
        topN: opts.topN ?? TOP_N_GATE,
        profile: opts.profile,
      })
      writeRaceJob({
        running: false,
        phase: outcome.race.applied ? 'Winner picked and applied' : outcome.race.awaitingHuman ? 'Winner picked, awaiting human approval' : 'Race finished (no winner)',
        race: outcome.race,
      })
    } catch (e) {
      console.error('[playground-evolve] top-N race failed', e)
      writeRaceJob({ running: false, phase: 'Error', lastError: String((e as Error)?.message ?? e) })
    }
  })()

  return { ok: true }
}

interface ScreenedFinalist {
  card: ChangeCard
  falsification: FalsificationResult
}

interface GatedFinalist extends ScreenedFinalist {
  gate: GateResult
}

export interface RaceOutcome {
  race: EvoRace
  /** Non-null only when the winner was committed to the version tree. */
  applied: ApplyResult | null
}

/**
 * §7.2④ race: repair-screen the top-N cards side by side → gate the survivors
 * (×repeats) → pick on the (success ↑, cost ↓) Pareto frontier → commit the
 * winner when the slider allows it.
 *
 * Every candidate gets a row in the race record, including the ones that were
 * dropped and why — the pick has to be auditable, otherwise "Pareto 择优" is
 * just a tie-break nobody can check.
 */
export async function raceTopCards(
  cards: ChangeCard[],
  autonomyLevel: number,
  opts: { repeats?: number; topN?: number; profile?: EvoProfile } = {},
): Promise<RaceOutcome> {
  const topN = Math.max(1, Math.min(5, opts.topN ?? TOP_N_GATE))
  const parent = currentGeneration() ?? ensureBaseGeneration(scoredLiveRepairRuns())
  const providerHint = scoredLiveRepairRuns().slice(-1)[0]?.provider
  const provider = { providerId: providerHint?.providerId, model: providerHint?.model }
  const temperature = 0.2
  // The demo profile pins its own repeat count; an explicit caller override still
  // wins, so the full profile keeps the §3.2 slider.
  const repeats = gateRepeatsFor(
    temperature,
    opts.repeats ?? EVO_PROFILES[opts.profile ?? 'full'].gateRepeats ?? undefined,
  )

  const entries: EvoRaceEntry[] = []
  const entryFor = (card: ChangeCard, dropped: string | null, gate?: GateResult): EvoRaceEntry => {
    const axis = paretoAxisOf({ avgCostUsd: gate?.avgCostUsd, avgTokens: gate?.avgTokens })
    return {
      cardId: card.cardId,
      title: card.title,
      surface: card.surface,
      seam: card.seam,
      dropped,
      baselinePassPp: gate?.baselinePassPp ?? 0,
      candidatePassPp: gate?.candidatePassPp ?? 0,
      gateLiftPp: gate?.gateLiftPp ?? 0,
      regressed: gate?.regressed.length ?? 0,
      fixed: gate?.fixed.length ?? 0,
      avgTokens: gate?.avgTokens ?? null,
      avgCostUsd: gate?.avgCostUsd ?? null,
      costAxis: axis,
      cost: paretoCostOf({ avgCostUsd: gate?.avgCostUsd, avgTokens: gate?.avgTokens }),
      onFrontier: false,
    }
  }

  const phase = (text: string) => {
    writeAutoJob({ phase: text })
    writeRaceJob({ running: true, phase: text })
  }

  // The candidates are screened side by side instead of one after the other. The
  // provider quota is paced centrally (providerQuota.ts), so a second screen no
  // longer has to queue behind the first: two screens overlap and the wall clock
  // of a two-card race roughly halves, without asking the provider for more
  // requests per minute than before. Results land in fixed slots so the table and
  // the finalist order stay deterministic whichever screen finishes first.
  const screenEntries: (EvoRaceEntry | null)[] = cards.map(() => null)
  const screenResults: (ScreenedFinalist | null)[] = cards.map(() => null)
  phase(`Repair screen: ${cards.length} candidate(s) side by side`)
  await Promise.all(cards.map(async (card, i) => {
    updateCardStatus(card.cardId, 'screening', 'pending')
    const cluster = getCluster(card.clusterId)
    if (!cluster) {
      updateCardStatus(card.cardId, 'falsified', 'falsified')
      screenEntries[i] = entryFor(card, 'failure cluster missing, cannot re-run')
      return
    }
    const failedRuns = cluster.runIds
      .map((id) => getRunDetail(id))
      .filter((r): r is RunDetail => !!r && r.success === false)
    if (!failedRuns.length) {
      updateCardStatus(card.cardId, 'falsified', 'falsified')
      screenEntries[i] = entryFor(card, 'no failed run available for re-runs')
      return
    }
    const passingRuns = scoredLiveRepairRuns().filter(
      (r) => r.success === true && r.fingerprint === parent.fingerprint && !cluster.runIds.includes(r.runId),
    )
    const falsification = await falsifyCard({
      card,
      baseConfig: parent.config,
      baseMounts: parent.mounts,
      failedRuns,
      passingRuns,
      provider,
      profile: opts.profile,
    })
    if ('error' in falsification) {
      updateCardStatus(card.cardId, 'proposed', 'pending')
      screenEntries[i] = entryFor(card, `repair screen failed: ${falsification.error}`)
      return
    }
    if (falsification.incomplete.length > 0) {
      updateCardFalsification(card.cardId, 'proposed', 'pending', falsification)
      screenEntries[i] = entryFor(card,
        `repair screen inconclusive: ${falsification.incomplete.length} task(s) produced no answer (${falsification.incomplete.join(', ')})`)
      return
    }
    if (!falsificationPasses(falsification)) {
      updateCardFalsification(card.cardId, 'falsified', 'falsified', falsification)
      screenEntries[i] = entryFor(card, falsification.regressed.length
        ? `repair screen regressed ${falsification.regressed.length} task(s)`
        : 'repair screen rescued nothing')
      return
    }
    screenResults[i] = { card, falsification }
  }))
  for (const e of screenEntries) if (e) entries.push(e)
  const screened: ScreenedFinalist[] = screenResults.filter((s): s is ScreenedFinalist => !!s)

  // Keep at most topN by repair net lift for the expensive gate pass. The rest
  // are not falsified — they simply never got a gate slot.
  screened.sort((a, b) => (b.falsification.netLiftPp ?? 0) - (a.falsification.netLiftPp ?? 0))
  const finalists = screened.slice(0, topN)
  for (const drop of screened.slice(topN)) {
    entries.push(entryFor(drop.card, `missed the top-${topN} after the repair screen (net lift ${drop.falsification.netLiftPp}pp)`))
  }

  // Same reasoning as the screen above: the finalists' held-out gates run side
  // by side under the same central quota pacing, and land in fixed slots so the
  // Pareto pick sees the same row order every run.
  const gateEntries: (EvoRaceEntry | null)[] = finalists.map(() => null)
  const gateResults: (GatedFinalist | null)[] = finalists.map(() => null)
  if (finalists.length > 0) phase(`gate×${repeats}: ${finalists.length} candidate(s) side by side`)
  await Promise.all(finalists.map(async (f, i) => {
    const cand = applyCardToConfig(f.card, parent.config, parent.mounts)
    const gate = await gateVerifyConfigs(
      cand,
      { config: parent.config, mounts: parent.mounts },
      { provider, repeats, temperature, profile: opts.profile },
    )
    if (!('gateTaskIds' in gate)) {
      updateCardStatus(f.card.cardId, 'proposed', 'pending')
      gateEntries[i] = entryFor(f.card, `gate verification failed: ${gate.error}`)
      return
    }
    if (gate.regressed.length > 0 || gate.gateLiftPp < 0) {
      updateCardStatus(f.card.cardId, 'falsified', 'falsified')
      gateEntries[i] = entryFor(f.card, gate.regressed.length
        ? `gate regressed ${gate.regressed.length} task(s)`
        : `gate lift ${gate.gateLiftPp}pp is negative`, gate)
      return
    }
    gateResults[i] = { ...f, gate }
  }))
  for (const e of gateEntries) if (e) entries.push(e)
  const gated: GatedFinalist[] = gateResults.filter((g): g is GatedFinalist => !!g)

  // Pareto pick over (success ↑, cost ↓); regressions already disqualified.
  const rows = gated.map((g) => ({
    id: g.card.cardId,
    successRate: g.gate.candidatePassPp / 100,
    cost: paretoCostOf({ avgCostUsd: g.gate.avgCostUsd, avgTokens: g.gate.avgTokens }),
    regressed: g.gate.regressed.length,
  }))
  const winnerId = pickParetoWinner(rows)
  // Only regression-free rows can win; the frontier is drawn among those.
  const frontSet = paretoFrontier(
    rows.filter((r) => r.regressed === 0).map((r) => ({ id: r.id, successRate: r.successRate, cost: r.cost })),
  )

  for (const g of gated) {
    entries.push(entryFor(g.card, g.card.cardId === winnerId ? null : 'lost the Pareto frontier', g.gate))
  }
  for (const e of entries) {
    if (e.dropped === null && frontSet.has(e.cardId)) e.onFrontier = true
  }

  const race: EvoRace = {
    raceId: `race_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: now(),
    topN,
    repeats,
    screened: screened.length,
    gated: gated.length,
    entries,
    winnerCardId: winnerId,
    awaitingHuman: false,
    applied: false,
    note: null,
  }

  if (!winnerId) {
    race.note = gated.length
      ? 'No candidate left on the Pareto frontier (all dominated or regressed).'
      : 'No candidate survived the gate pass.'
    return { race, applied: null }
  }

  const winner = gated.find((g) => g.card.cardId === winnerId)!
  // §7.5: slider 0, hard-gate seams and out-of-table cards never auto-apply —
  // the race stops at the pick and waits for a human click.
  if (autonomyLevel <= 0 || requireHumanFor(winner.card)) {
    race.awaitingHuman = true
    race.applied = false
    race.note = requireHumanFor(winner.card)
      ? 'The Pareto winner is a hard-gate / out-of-table card: it needs human approval at every level.'
      : 'Slider is at level 0 (all manual): a winner was picked but waits for human approval.'
    for (const g of gated) {
      // Nothing here was falsified — they passed the screen and the gate and
      // simply lost the comparison, so they stay available for a human pick.
      updateCardStatus(g.card.cardId, 'proposed', 'pending')
    }
    return { race, applied: null }
  }

  for (const g of gated) {
    if (g.card.cardId !== winnerId) updateCardStatus(g.card.cardId, 'proposed', 'pending')
  }
  phase(`Pareto winner "${winner.card.title}" — committing to the version tree`)
  const applied = commitPassedCard(winner.card, winner.falsification, { mode: 'auto', autonomyLevel }, {
    result: winner.gate,
    status: 'passed',
  })
  race.applied = applied.ok
  race.note = applied.ok
    ? `Pareto frontier pick "${winner.card.title}" (gate ${winner.gate.gateLiftPp}pp, cost axis ${paretoAxisOf({ avgCostUsd: winner.gate.avgCostUsd, avgTokens: winner.gate.avgTokens })})`
    : applied.error ?? 'Failed to apply the winning card.'
  return { race, applied }
}


/**
 * Run the loop analyze → top-2 repair screen → gate×repeats → Pareto pick →
 * apply, until: no failures remain, a hard-gate/out-of-table card blocks,
 * or NO_LIFT_LIMIT consecutive generations show no positive lift (§7.5).
 */
export function startAutoEvolve(autonomyLevel: number): { ok: boolean; error?: string } {
  if (getAutoJob()?.running) return { ok: false, error: 'Self-evolution is already running.' }
  if (autonomyLevel === 0) return { ok: false, error: 'Slider is at level 0 (all manual) — auto-evolution cannot run.' }
  writeAutoJob({ running: true, phase: 'Starting attribution', generationsApplied: 0, stopReason: null, lastError: null })

  void (async () => {
    let noLiftStreak = 0
    try {
      for (let gen = 0; gen < MAX_AUTO_GENERATIONS; gen += 1) {
        writeAutoJob({ phase: `Generation ${gen + 1}: clustering failures` })
        const analysis = await analyze()
        if (analysis.clusters.length === 0) {
          writeAutoJob({ running: false, phase: 'Done', stopReason: analysis.note ?? 'The current baseline has no failed runs left; self-evolution has converged.' })
          return
        }
        const top = chooseTopCards(analysis.cards, autonomyLevel, TOP_N_GATE)
        if (!top.length) {
          writeAutoJob({ running: false, phase: 'Awaiting human', stopReason: 'Every remaining candidate is a hard-gate / out-of-table / human-judgement card; auto-iteration stops here for human approval.' })
          return
        }
        writeAutoJob({
          phase: `Generation ${gen + 1}: top-${top.length} side-by-side falsification (repair screen → gate×repeats → Pareto)`,
        })
        const outcome = await raceTopCards(top, autonomyLevel)
        writeRaceJob({ running: false, race: outcome.race, updatedAt: now() })
        if (!outcome.applied || !outcome.applied.ok || !outcome.applied.generation) {
          const reason = outcome.race.note ?? 'This generation\'s race produced no appliable winner.'
          if (outcome.race.awaitingHuman) {
            writeAutoJob({ running: false, phase: 'Awaiting human', stopReason: reason })
            return
          }
          noLiftStreak += 1
          if (reachedNoLiftStop(noLiftStreak)) {
            writeAutoJob({ running: false, phase: 'Stopped', stopReason: `${NO_LIFT_LIMIT} consecutive generations with no positive lift; self-evolution stops.` })
            return
          }
          continue
        }
        const result = outcome.applied
        const lift = result.falsification?.netLiftPp ?? 0
        if (lift > 0) noLiftStreak = 0
        else {
          noLiftStreak += 1
          if (reachedNoLiftStop(noLiftStreak)) {
            writeAutoJob({ running: false, phase: 'Stopped', stopReason: `${NO_LIFT_LIMIT} consecutive generations with no positive lift; self-evolution stops.` })
            return
          }
        }
        writeAutoJob({ phase: `Generation ${gen + 1} applied (net lift ${lift}pp)`, generationsApplied: gen + 1 })
      }
      writeAutoJob({ running: false, phase: 'Limit reached', stopReason: `Hit the ${MAX_AUTO_GENERATIONS}-generation cap for one auto run; inspect and continue manually.` })
    } catch (e) {
      writeAutoJob({ running: false, phase: 'Error', lastError: String((e as Error)?.message ?? e) })
    }
  })()
  return { ok: true }
}

export interface EvoState {
  clusters: EvoCluster[]
  cards: ChangeCard[]
  generations: EvoGeneration[]
  mutations: EvoMutation[]
  currentGenerationId: string | null
  autoJob?: AutoJob | null
  raceJob?: EvoRaceJob | null
}

export function getEvoState(): EvoState {
  return {
    clusters: listClusters(),
    cards: listCards(),
    generations: listGenerations(),
    mutations: listMutations(),
    currentGenerationId: currentGeneration()?.generationId ?? null,
    autoJob: getAutoJob(),
    raceJob: getRaceJob(),
  }
}
