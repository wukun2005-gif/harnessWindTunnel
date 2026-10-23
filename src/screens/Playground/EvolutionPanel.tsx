import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import type {
  ApplyResult,
  ChangeCard,
  EvoCluster,
  EvoGeneration,
  EvoMutation,
  EvoRace,
  EvoRaceJob,
  EvoState,
} from '../../../shared/playground'
import { EVO_PROFILES, gateTasksFor, type EvoProfile } from '../../../shared/playground'
import { useEvoI18n } from './evoI18n'

const SLIDER_KEY = 'hwt-pg-autonomy'
/** §3.2 gate repeats per (task × config). Default 3 while temperature > 0. */
const REPEATS_KEY = 'hwt-pg-gate-repeats'
/** How many cards race side by side (design §7.2④ top-2). */
const TOPN_KEY = 'hwt-pg-race-topn'
const PROFILE_KEY = 'hwt-pg-profile'
/** Real executions per screen repetition: the parent run plus the candidate run. */
const RUNS_PER_SLOT = 2
/** Repetitions per screen slot — a flip has to reproduce before it is named. */
const SCREEN_REPEATS = 2
/** Screen repetitions per slot as the demo profile runs them. */
const DEMO_SCREEN_REPEATS = EVO_PROFILES.demo.screenRepeats ?? SCREEN_REPEATS
const DEMO_SCREEN_SIZE = (EVO_PROFILES.demo.screenFailed + EVO_PROFILES.demo.screenGuards) * RUNS_PER_SLOT * DEMO_SCREEN_REPEATS
/** At or below this many paired gate runs, the panel stops presenting a lift as a measurement. */
const DEMO_GATE_SAMPLES = (EVO_PROFILES.demo.gateTaskIds?.length ?? 0) * 2

type CardPhase = 'screening' | 'ready' | 'needs' | 'human' | 'applied' | 'failed'
type InboxFilter = 'all' | 'ready' | 'needs' | 'running' | 'applied' | 'closed'

const PHASE_TONE: Record<CardPhase, string> = {
  screening: 'run',
  ready: 'good',
  needs: 'warn',
  human: 'warn',
  applied: 'good',
  failed: 'bad',
}

const PHASE_RANK: Record<CardPhase, number> = {
  screening: 0,
  ready: 1,
  needs: 2,
  human: 3,
  applied: 4,
  failed: 5,
}

/** USD with 4 significant decimals — gate runs cost fractions of a cent. */
function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}

/**
 * Local wall-clock stamp for a stored result, minute precision. A card can be
 * re-screened after every fix and comes back with numbers of the same shape, so
 * the stamp is what tells one screening apart from the one it replaced.
 */
function fmtStamp(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function humanField(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
}

/**
 * The same failure key analysed twice with the same run set keeps the cluster id,
 * so its card table accumulates identical-looking proposals. Keep the newest card
 * per (surface, title); older copies stay reachable through the Applied/Closed
 * filters and the version tree.
 */
function newestPerShape(cards: ChangeCard[]): ChangeCard[] {
  const seen = new Set<string>()
  return cards.filter((card) => {
    const shape = `${card.surface}::${card.title}`
    if (seen.has(shape)) return false
    seen.add(shape)
    return true
  })
}

function phaseOf(card: ChangeCard, mutation: EvoMutation | undefined): CardPhase {
  if (card.status === 'screening' || mutation?.gateStatus === 'running') return 'screening'
  if (card.status === 'applied') return 'applied'
  if (card.status === 'falsified' || card.status === 'rejected') return 'failed'
  if (card.verdict === 'needs-human') return 'human'
  const f = mutation?.falsification ?? card.falsification
  if (!f || f.incomplete.length > 0) return 'needs'
  if (f.hardGateRegressed || f.hardRegressions.length > 0 || f.regressed.length > 0) return 'failed'
  if (f.rescued.length > 0 || (f.netLiftPp ?? 0) > 0) return 'ready'
  return 'needs'
}

interface FailureGroup {
  key: string
  analyses: EvoCluster[]
  latest: EvoCluster
  /** Cards proposed by the latest analysis — the default inbox content. */
  latestCards: ChangeCard[]
}

function cardsFor(
  group: FailureGroup,
  filter: InboxFilter,
  mutationByCard: Map<string, EvoMutation>,
): ChangeCard[] {
  // Every tab counts the same base (the latest pass for this failure type), so a
  // narrower tab can never show a bigger number than "All". Applied history lives
  // in the version tree, not in the inbox.
  if (filter === 'applied') return group.latestCards.filter((c) => c.status === 'applied')
  if (filter === 'closed') {
    return group.latestCards.filter((c) => c.status === 'falsified' || c.status === 'rejected')
  }
  if (filter === 'all') return group.latestCards
  return group.latestCards.filter((c) => {
    const p = phaseOf(c, mutationByCard.get(c.cardId))
    if (filter === 'needs') return p === 'needs' || p === 'human'
    if (filter === 'running') return p === 'screening'
    return p === filter
  })
}

function groupRank(group: FailureGroup, mutationByCard: Map<string, EvoMutation>): number {
  const phases = group.latestCards.map((c) => phaseOf(c, mutationByCard.get(c.cardId)))
  if (phases.length === 0) return 9
  return Math.min(...phases.map((p) => PHASE_RANK[p]))
}

export default function EvolutionPanel({ onOpenEvaluate }: { onOpenEvaluate?: () => void }) {
  const E = useEvoI18n()
  const [state, setState] = useState<EvoState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [level, setLevel] = useState<number>(() => Number(localStorage.getItem(SLIDER_KEY) ?? '1'))
  const [repeats, setRepeats] = useState<number>(() => Number(localStorage.getItem(REPEATS_KEY) ?? '3'))
  const [topN, setTopN] = useState<number>(() => Number(localStorage.getItem(TOPN_KEY) ?? '2'))
  const [profile, setProfile] = useState<EvoProfile>(
    () => (localStorage.getItem(PROFILE_KEY) === 'full' ? 'full' : 'demo'),
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [filter, setFilter] = useState<InboxFilter>('all')
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(SLIDER_KEY, String(level))
  }, [level])
  useEffect(() => {
    localStorage.setItem(REPEATS_KEY, String(repeats))
  }, [repeats])
  useEffect(() => {
    localStorage.setItem(TOPN_KEY, String(topN))
  }, [topN])
  useEffect(() => {
    localStorage.setItem(PROFILE_KEY, profile)
  }, [profile])

  const refresh = () => api.pgEvoState().then((s) => setState(s)).catch((e) => setErr(String(e.message)))

  useEffect(() => {
    void refresh()
  }, [])

  // While any card is mid-falsification, a gate verify runs, or the auto loop
  // is active (all are multi-minute live re-runs), poll.
  const busyPolling = useMemo(() => {
    const screeningCard = (state?.cards ?? []).some((c) => c.status === 'screening')
    const gateRunning = (state?.mutations ?? []).some((m) => m.gateStatus === 'running')
    const autoRunning = state?.autoJob?.running === true
    const raceRunning = state?.raceJob?.running === true
    return screeningCard || gateRunning || autoRunning || raceRunning
  }, [state])
  useEffect(() => {
    if (!busyPolling) return
    const timer = setInterval(() => {
      void api.pgEvoState().then((s) => setState(s)).catch(() => { /* keep polling */ })
    }, 4000)
    return () => clearInterval(timer)
  }, [busyPolling])

  const analyze = async () => {
    setBusy('analyze')
    setErr(null)
    setNote(null)
    try {
      const r = await api.pgEvolve()
      setState(r.state)
      setNote(r.note ?? null)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const apply = async (card: ChangeCard, mode: 'manual' | 'auto') => {
    setBusy(card.cardId)
    setErr(null)
    setNote(null)
    try {
      const r: ApplyResult & { ok: boolean; state: EvoState; error?: string } = await api.pgApplyCard(card.cardId, {
        mode,
        autonomyLevel: level,
        profile,
      })
      setState(r.state)
      if (!r.ok && r.error) setErr(r.error)
      if (r.started) {
        const slots = EVO_PROFILES[profile].screenFailed + EVO_PROFILES[profile].screenGuards
        setNote(E.t(profile === 'demo' ? 'playground.evo.note.demoApply' : 'playground.evo.note.fullApply', {
          slots,
          runs: slots * 2,
        }))
      }
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const autoEvolve = async () => {
    if (!window.confirm(E.t('playground.evo.confirm.auto'))) return
    setBusy('auto')
    setErr(null)
    try {
      const r = await api.pgAutoEvolve(level)
      setState(r.state)
      if (!r.ok && r.error) setErr(r.error)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const gateVerify = async (commitId: string) => {
    setBusy(commitId)
    setErr(null)
    try {
      // The demo profile owns the repeat count. Passing the knob's value would always
      // override it — the select always has a number in it — so the knob's ×N only
      // applies to the full profile.
      const r = await api.pgGateVerify(commitId, profile === 'demo' ? { profile } : { repeats, profile })
      setState(r.state)
      if (!r.ok && r.error) setErr(r.error)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const race = async () => {
    // Cost must be quoted from the profile that will actually run, not from the
    // full measured set — the demo profile uses 3 gate tasks at ×1 and one
    // repetition per screened slot.
    const gateN = gateTasksFor(profile)?.length ?? 13
    const gateRep = profile === 'demo' ? (EVO_PROFILES.demo.gateRepeats ?? 1) : repeats
    const screenRep = EVO_PROFILES[profile].screenRepeats ?? SCREEN_REPEATS
    const screenRuns = (EVO_PROFILES[profile].screenFailed + EVO_PROFILES[profile].screenGuards) * RUNS_PER_SLOT * screenRep
    const cost = topN * (screenRuns + gateN * gateRep * 2)
    if (!window.confirm(
      E.t('playground.evo.confirm.race', {
        n: topN,
        profile: E.t(profile === 'demo' ? 'playground.evo.profileLower.demo' : 'playground.evo.profileLower.full'),
        failed: EVO_PROFILES[profile].screenFailed,
        guards: EVO_PROFILES[profile].screenGuards,
        rep: screenRep,
        gate: gateN,
        gateRep,
        cost,
      }),
    )) return
    setBusy('race')
    setErr(null)
    try {
      const r = await api.pgRace({ autonomyLevel: level, topN, profile, ...(profile === 'demo' ? {} : { repeats }) })
      setState(r.state)
      if (!r.ok && r.error) setErr(r.error)
      else setNote(E.t('playground.evo.note.raceStarted'))
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const rollback = async (g: EvoGeneration) => {
    const card = state?.cards.find((c) => c.cardId === g.cardId) ?? null
    const cluster = card ? state?.clusters.find((c) => c.clusterId === card.clusterId) ?? null : null
    const label = E.generationLabel(g, card, cluster)
    if (!window.confirm(E.t('playground.evo.confirm.rollback', { label }))) return
    setBusy(g.generationId)
    try {
      const r = await api.pgRollback(g.generationId)
      setState(r.state)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const mutationByCard = useMemo(() => {
    const m = new Map<string, EvoMutation>()
    for (const mu of state?.mutations ?? []) m.set(mu.cardId, mu)
    return m
  }, [state])

  const clusterById = useMemo(() => {
    const m = new Map<string, EvoCluster>()
    for (const c of state?.clusters ?? []) m.set(c.clusterId, c)
    return m
  }, [state])

  const cardById = useMemo(() => {
    const m = new Map<string, ChangeCard>()
    for (const c of state?.cards ?? []) m.set(c.cardId, c)
    return m
  }, [state])

  // Repeated diagnoses create a fresh cluster (and a fresh copy of the same card)
  // for the same underlying failure. Group by the stable failure key so the inbox
  // reads as "failure types", not "every analysis ever run".
  const groups = useMemo<FailureGroup[]>(() => {
    const byKey = new Map<string, EvoCluster[]>()
    for (const c of state?.clusters ?? []) {
      const arr = byKey.get(c.key) ?? []
      arr.push(c)
      byKey.set(c.key, arr)
    }
    const out: FailureGroup[] = []
    for (const [key, list] of byKey) {
      const analyses = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      const latest = analyses[0]!
      const allCards = (state?.cards ?? [])
        .filter((card) => clusterById.get(card.clusterId)?.key === key)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      out.push({
        key,
        analyses,
        latest,
        latestCards: newestPerShape(allCards.filter((c) => c.clusterId === latest.clusterId)),
      })
    }
    return out.sort(
      (a, b) =>
        groupRank(a, mutationByCard) - groupRank(b, mutationByCard) ||
        b.latest.createdAt.localeCompare(a.latest.createdAt),
    )
  }, [state, clusterById, mutationByCard])

  const visibleGroups = useMemo(
    () =>
      groups
        .map((g) => ({ group: g, cards: cardsFor(g, filter, mutationByCard) }))
        .filter(({ group, cards }) => cards.length > 0 || (filter === 'all' && group.latestCards.length === 0)),
    [groups, filter, mutationByCard],
  )

  const filterCount = (f: InboxFilter): number =>
    groups.reduce((n, g) => n + cardsFor(g, f, mutationByCard).length, 0)

  const visibleCards = visibleGroups.flatMap((x) => x.cards)
  const activeCard = visibleCards.find((c) => c.cardId === selectedId) ?? visibleCards[0] ?? null
  const activeCluster = activeCard ? clusterById.get(activeCard.clusterId) ?? null : null
  const activeMutation = activeCard ? mutationByCard.get(activeCard.cardId) ?? null : null

  const latestCards = groups.flatMap((g) => g.latestCards)
  const screeningCount = latestCards.filter((c) => phaseOf(c, mutationByCard.get(c.cardId)) === 'screening').length
  const readyCards = latestCards.filter((c) => phaseOf(c, mutationByCard.get(c.cardId)) === 'ready')
  const needsCards = latestCards.filter((c) => phaseOf(c, mutationByCard.get(c.cardId)) === 'needs')
  const humanCards = latestCards.filter((c) => phaseOf(c, mutationByCard.get(c.cardId)) === 'human')
  const verifiedCards = latestCards.filter((c) => (mutationByCard.get(c.cardId)?.falsification ?? c.falsification) != null).length
  const evolveGens = (state?.generations ?? []).filter((g) => g.source === 'evolve')
  const currentGen = (state?.generations ?? []).find((g) => g.generationId === state?.currentGenerationId) ?? null
  const currentCard = currentGen?.cardId ? cardById.get(currentGen.cardId) ?? null : null
  const currentCluster = currentCard ? clusterById.get(currentCard.clusterId) ?? null : null
  const currentLabel = currentGen
    ? E.generationLabel(currentGen, currentCard, currentCluster)
    : E.t('playground.evo.noVersion')

  const focusCard = (card: ChangeCard) => {
    setFilter('all')
    setSelectedId(card.cardId)
    requestAnimationFrame(() => {
      document.getElementById('pg-evo-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  const next = (() => {
    if (!state) return null
    if (screeningCount > 0) {
      return {
        tone: 'run',
        title: E.t('playground.evo.next.screeningTitle', { n: screeningCount }),
        body: E.t('playground.evo.next.screeningBody'),
        card: null as ChangeCard | null,
        action: '',
      }
    }
    if (readyCards.length > 0) {
      return {
        tone: 'good',
        title: E.t('playground.evo.next.readyTitle', { n: readyCards.length }),
        body: E.t('playground.evo.next.readyBody'),
        card: readyCards[0]!,
        action: E.t('playground.evo.next.readyAction'),
      }
    }
    if (needsCards.length > 0) {
      return {
        tone: 'warn',
        title: E.t('playground.evo.next.needsTitle', { n: needsCards.length }),
        body: E.t('playground.evo.next.needsBody'),
        card: needsCards[0]!,
        action: E.t('playground.evo.next.needsAction'),
      }
    }
    if (humanCards.length > 0) {
      return {
        tone: 'warn',
        title: E.t('playground.evo.next.humanTitle'),
        body: E.t('playground.evo.next.humanBody'),
        card: humanCards[0]!,
        action: E.t('playground.evo.next.humanAction'),
      }
    }
    return {
      tone: 'done',
      title: E.t('playground.evo.next.doneTitle'),
      body: E.t('playground.evo.next.doneBody'),
      card: null,
      action: '',
    }
  })()

  return (
    <div className="pg-evo">
      <div className="pg-evo-hero">
        <div className="pg-evo-intro">
          <span className="pg-eyebrow">{E.t('playground.evo.eyebrow')}</span>
          <h2>{E.t('playground.evo.title')}</h2>
          <p>{E.t('playground.evo.intro')}</p>
        </div>
        <div className="pg-evo-pills">
          <span className="pg-evo-pill">
            <span>{E.t('playground.evo.currentVersion')}</span>
            <b>{currentLabel}</b>
          </span>
          <span className="pg-evo-pill">
            <span>{E.t('playground.evo.profile')}</span>
            <b>{E.t(profile === 'demo' ? 'playground.evo.profileDemo' : 'playground.evo.profileFull')}</b>
          </span>
          <span className="pg-evo-pill">
            <span>{E.t('playground.evo.autonomy')}</span>
            <b>{level} · {E.autonomy(level)}</b>
          </span>
        </div>
      </div>

      <div className="pg-evo-runbar">
        <button
          className="primary pg-diagnose"
          onClick={() => void analyze()}
          disabled={busy === 'analyze' || state?.autoJob?.running}
        >
          {busy === 'analyze' ? E.t('playground.evo.diagnosing') : E.t('playground.evo.diagnose')}
        </button>
        <span className="pg-runbar-explain">{E.t('playground.evo.diagnoseHint')}</span>
        <div className="pg-evo-runbar-actions">
          <button onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}>
            {E.t(settingsOpen ? 'playground.evo.hideSettings' : 'playground.evo.runSettings')}
          </button>
          <details className="pg-more">
            <summary>{E.t('playground.evo.moreRuns')}</summary>
            <div className="pg-more-body">
              <button
                onClick={() => void race()}
                disabled={busy === 'race' || state?.raceJob?.running || state?.autoJob?.running}
              >
                {state?.raceJob?.running
                  ? E.t('playground.evo.raceRunning')
                  : E.t('playground.evo.race', { n: topN })}
              </button>
              <label>
                {E.t('playground.evo.raceWidth')}
                <select value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
                  <option value={2}>{E.t('playground.evo.raceWidthDefault')}</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                </select>
              </label>
              <button
                onClick={() => void autoEvolve()}
                disabled={busy === 'auto' || state?.autoJob?.running || level === 0}
              >
                {state?.autoJob?.running
                  ? E.t('playground.evo.continuousActive')
                  : E.t('playground.evo.runContinuous')}
              </button>
            </div>
          </details>
        </div>
      </div>

      {settingsOpen && (
        <div className="pg-evo-settings">
          <label className="pg-setting-field">
            <span>{E.t('playground.evo.profile')}</span>
            <select value={profile} onChange={(e) => setProfile(e.target.value as EvoProfile)}>
              <option value="demo">
                {E.t('playground.evo.profileOption.demo', {
                  failed: EVO_PROFILES.demo.screenFailed,
                  guards: EVO_PROFILES.demo.screenGuards,
                  gate: EVO_PROFILES.demo.gateTaskIds?.length ?? 0,
                  reps: EVO_PROFILES.demo.gateRepeats ?? 1,
                })}
              </option>
              <option value="full">
                {E.t('playground.evo.profileOption.full', {
                  failed: EVO_PROFILES.full.screenFailed,
                  guards: EVO_PROFILES.full.screenGuards,
                })}
              </option>
            </select>
            <small>{E.t('playground.evo.profileHint')}</small>
          </label>
          <label className="pg-setting-field">
            <span>{E.t('playground.evo.autonomy')}</span>
            <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
              <option value={0}>{E.t('playground.evo.autonomyOption.0')}</option>
              <option value={1}>{E.t('playground.evo.autonomyOption.1')}</option>
              <option value={2}>{E.t('playground.evo.autonomyOption.2')}</option>
            </select>
            <small>{E.t('playground.evo.autonomyHint')}</small>
          </label>
          <label className="pg-setting-field">
            <span>{E.t('playground.evo.gateRepeats')}</span>
            <select
              value={repeats}
              onChange={(e) => setRepeats(Number(e.target.value))}
              title={E.t('playground.evo.gateRepeatsTitle')}
            >
              <option value={1}>×1</option>
              <option value={2}>×2</option>
              <option value={3}>{E.t('playground.evo.gateRepeatsDefault')}</option>
              <option value={5}>×5</option>
            </select>
            <small>{E.t('playground.evo.gateRepeatsHint')}</small>
          </label>
          <p className="pg-guardrail">{E.t('playground.evo.guardrail')}</p>
        </div>
      )}

      {state?.autoJob && (
        <div className={`pg-autojob ${state.autoJob.running ? 'pg-autojob-run' : 'pg-autojob-done'}`}>
          <b>{E.t(state.autoJob.running ? 'playground.evo.autoRunning' : 'playground.evo.autoFinished')}</b>
          {E.msg(state.autoJob.phase)}
          {state.autoJob.generationsApplied > 0 && E.t('playground.evo.autoGenerations', { n: state.autoJob.generationsApplied })}
          {state.autoJob.stopReason && (
            <span className="pg-autojob-stop"> | {E.msg(state.autoJob.stopReason)}</span>
          )}
          {state.autoJob.lastError && <span className="pg-err"> | {E.msg(state.autoJob.lastError)}</span>}
        </div>
      )}

      {state?.raceJob && (
        <details className="pg-race-fold" open={state.raceJob.running}>
          <summary>
            <b>{E.t('playground.evo.raceTitle')}</b>
            <span>
              {state.raceJob.running
                ? E.msg(state.raceJob.phase)
                : state.raceJob.race
                  ? E.t(state.raceJob.race.winnerCardId
                    ? 'playground.evo.raceComparedWinner'
                    : 'playground.evo.raceComparedNoWinner', { n: state.raceJob.race.entries.length })
                  : E.msg(state.raceJob.phase)}
            </span>
            {state.raceJob.lastError && <span className="pg-err">{E.msg(state.raceJob.lastError)}</span>}
          </summary>
          <RacePanel
            job={state.raceJob}
            cards={state.cards}
            clusters={state.clusters}
            onApply={apply}
          />
        </details>
      )}

      {note && <p className="pg-note">{E.msg(note)}</p>}
      {err && <p className="pg-err">{E.msg(err)}</p>}

      {!state ? (
        <div className="pg-empty">
          {err ? E.t('playground.evo.loadFail') : E.t('playground.evo.loading')}
        </div>
      ) : state.clusters.length === 0 ? (
        <div className="pg-evo-empty">
          <div className="pg-empty-mark">{E.t('playground.evo.noEvidence')}</div>
          <h3>{E.t('playground.evo.emptyTitle')}</h3>
          <p>{E.t('playground.evo.emptyBody')}</p>
          {onOpenEvaluate && (
            <button className="primary" onClick={onOpenEvaluate}>{E.t('playground.evo.goEvaluate')}</button>
          )}
        </div>
      ) : (
        <>
          <div className="pg-evo-steps">
            <div className="pg-evo-step">
              <span className="pg-step-index">1</span>
              <div>
                <b>{E.t('playground.evo.step.diagnose')}</b>
                <span>{E.t('playground.evo.step.groups', { n: groups.length })}</span>
              </div>
            </div>
            <div className="pg-evo-step">
              <span className="pg-step-index">2</span>
              <div>
                <b>{E.t('playground.evo.step.propose')}</b>
                <span>{E.t('playground.evo.step.cards', { n: latestCards.length })}</span>
              </div>
            </div>
            <div className="pg-evo-step">
              <span className="pg-step-index">3</span>
              <div>
                <b>{E.t('playground.evo.step.falsify')}</b>
                <span>{E.t('playground.evo.step.verified', { n: verifiedCards })}</span>
              </div>
            </div>
            <div className="pg-evo-step">
              <span className="pg-step-index">4</span>
              <div>
                <b>{E.t('playground.evo.step.approve')}</b>
                <span>{E.t('playground.evo.step.versions', { n: evolveGens.length })}</span>
              </div>
            </div>
          </div>

          {next && (
            <div className={`pg-evo-next pg-next-${next.tone}`}>
              <div>
                <b>{next.title}</b>
                <span>{next.body}</span>
              </div>
              {next.card && (
                <button onClick={() => focusCard(next.card!)}>{next.action}</button>
              )}
            </div>
          )}

          <div className="pg-evo-work">
            <aside className="pg-inbox">
              <div className="pg-inbox-head">
                <div>
                  <h3>{E.t('playground.evo.inbox.title')}</h3>
                  <span>
                    {E.t('playground.evo.inbox.sub', { n: groups.length })}
                    {groups.some((g) => g.analyses.length > 1) && ` · ${E.t('playground.evo.inbox.folded')}`}
                  </span>
                </div>
              </div>
              <div className="pg-inbox-filters">
                {(['all', 'ready', 'needs', 'running', 'applied', 'closed'] as InboxFilter[]).map((id) => {
                  const n = filterCount(id)
                  return (
                    <button
                      key={id}
                      className={`pg-filter-chip ${filter === id ? 'active' : ''}`}
                      onClick={() => setFilter(id)}
                    >
                      {E.t(`playground.evo.filter.${id}`)}<span>{n}</span>
                    </button>
                  )
                })}
              </div>

              <div className="pg-inbox-list">
                {visibleGroups.length === 0 ? (
                  <div className="pg-inbox-empty">{E.t('playground.evo.inbox.empty')}</div>
                ) : (
                  visibleGroups.map(({ group, cards }) => {
                    const route = group.latest.routeHistory[group.latest.routeHistory.length - 1]
                    return (
                      <div className="pg-inbox-group" key={group.key}>
                        <div className="pg-inbox-group-head">
                          <span className="pg-inbox-tag">{E.mast(group.latest.tag)}</span>
                          <span className="pg-inbox-count">
                            {E.t('playground.evo.inbox.failed', { n: group.latest.count })}
                          </span>
                          <span className="pg-inbox-domain">{E.domain(group.latest.domain)}</span>
                        </div>
                        <div className="pg-inbox-seam">
                          {E.seam(group.latest.seam)}
                          <span>→ {E.surface(route?.surface ?? 'joint')}</span>
                        </div>
                        {cards.length === 0 ? (
                          <div className="pg-inbox-empty-card">{E.t('playground.evo.inbox.noCard')}</div>
                        ) : (
                          cards.map((card, i) => {
                            const p = phaseOf(card, mutationByCard.get(card.cardId))
                            const active = activeCard?.cardId === card.cardId
                            const stale = card.clusterId !== group.latest.clusterId
                            return (
                              <button
                                key={card.cardId}
                                className={`pg-card-row ${active ? 'active' : ''}`}
                                onClick={() => setSelectedId(card.cardId)}
                              >
                                <span className="pg-row-top">
                                  <span className="pg-row-seq">#{i + 1}</span>
                                  <span className="pg-row-title">{E.cardTitle(card, group.latest)}</span>
                                  <span className={`pg-phase pg-phase-${PHASE_TONE[p]}`}>{E.phase(p)}</span>
                                </span>
                                <span className="pg-row-meta">
                                  <span>{E.surface(card.surface)}</span>
                                  <span>{fmtStamp(card.createdAt) ?? E.t('playground.evo.inbox.unknownTime')}</span>
                                  {stale && <span className="pg-row-stale">{E.t('playground.evo.inbox.earlier')}</span>}
                                </span>
                              </button>
                            )
                          })
                        )}
                        {group.analyses.length > 1 && (
                          <div className="pg-inbox-history">
                            {E.t('playground.evo.inbox.grouped', {
                              n: group.analyses.length,
                              count: group.latest.count,
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </aside>

            <section className="pg-evo-detail" id="pg-evo-detail">
              {activeCard ? (
                <CardDetail
                  card={activeCard}
                  cluster={activeCluster}
                  mutation={activeMutation}
                  busy={busy === activeCard.cardId || activeCard.status === 'screening' || activeMutation?.gateStatus === 'running'}
                  level={level}
                  onApply={apply}
                  onGate={gateVerify}
                />
              ) : (
                <div className="pg-detail-placeholder">
                  <b>{E.t('playground.evo.selectCard')}</b>
                  <span>{E.t('playground.evo.selectCardHint')}</span>
                </div>
              )}
            </section>
          </div>

          <VersionTimeline state={state} busy={busy} onRollback={rollback} />
        </>
      )}
    </div>
  )
}

function CardDetail({
  card,
  cluster,
  mutation,
  busy,
  level,
  onApply,
  onGate,
}: {
  card: ChangeCard
  cluster: EvoCluster | null
  mutation: EvoMutation | null
  busy: boolean
  level: number
  onApply: (card: ChangeCard, mode: 'manual' | 'auto') => void
  onGate: (commitId: string) => void
}) {
  const E = useEvoI18n()
  const phase = phaseOf(card, mutation ?? undefined)
  const f = mutation?.falsification ?? card.falsification
  const gate = mutation?.gate ?? null
  const gateStatus = mutation?.gateStatus ?? 'idle'
  const hardHuman = card.hardGate || !card.inTable || card.verdict === 'needs-human'
  const canApply = card.status !== 'applied' && card.status !== 'screening' && card.verdict !== 'needs-human'
  const hasChanges = !!(card.promptDiff || card.middlewareDiff || card.mountDiff)
  const route = cluster?.routeHistory[cluster.routeHistory.length - 1]

  return (
    <div className="pg-detail-body">
      <div className="pg-detail-head">
        <div className="pg-detail-kicker">
          <span className={`pg-surface pg-surface-${card.surface}`}>{E.surface(card.surface)}</span>
          <span className={`pg-phase pg-phase-${PHASE_TONE[phase]}`}>{E.phase(phase)}</span>
          <button
            type="button"
            className="pg-card-uid"
            title={E.t('playground.evo.detail.cardIdTitle', { id: card.cardId })}
            onClick={() => { void navigator.clipboard?.writeText(card.cardId) }}
          >
            {card.cardId}
          </button>
        </div>
        <h3>{E.cardTitle(card, cluster)}</h3>
        <p className="pg-detail-nl">{E.cardNl(card, cluster)}</p>
        <div className="pg-detail-meta">
          <span>{E.t('playground.evo.detail.proposed', { time: fmtStamp(card.createdAt) ?? '—' })}</span>
          {cluster && (
            <span>{E.t('playground.evo.detail.failedRuns', { n: cluster.count, domain: E.domain(cluster.domain) })}</span>
          )}
          {mutation && <span>{E.t('playground.evo.detail.appliedAs', { id: mutation.generationId })}</span>}
        </div>
      </div>

      <div className="pg-detail-section">
        <div className="pg-detail-label">{E.t('playground.evo.detail.why')}</div>
        <p className="pg-detail-why">
          {cluster ? E.clusterSummary(cluster) : E.t('playground.evo.detail.clusterGone')}
        </p>
        <dl className="pg-detail-kv">
          <div>
            <dt>{E.t('playground.evo.detail.seam')}</dt>
            <dd>{E.seam(cluster?.seam ?? card.seam)}</dd>
          </div>
          <div>
            <dt>{E.t('playground.evo.detail.routedTo')}</dt>
            <dd>
              {E.surface(route?.surface ?? card.surface)}
              {route?.reason && <span className="faint"> — {E.routeReason(route.reason)}</span>}
            </dd>
          </div>
          {cluster && cluster.criticalSteps.length > 0 && (
            <div>
              <dt>{E.t('playground.evo.detail.criticalSteps')}</dt>
              <dd>
                {[...new Set(cluster.criticalSteps)]
                  .map((n) => E.t('playground.evo.detail.step', { n }))
                  .join('、')}
              </dd>
            </div>
          )}
          {cluster && cluster.taskIds.length > 0 && (
            <div>
              <dt>{E.t('playground.evo.detail.tasks')}</dt>
              <dd>{cluster.taskIds.join(', ')}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="pg-detail-section">
        <div className="pg-detail-label">{E.t('playground.evo.detail.whatChanges')}</div>
        {hasChanges ? <ChangePreview card={card} /> : (
          <p className="pg-diff-empty">{E.t('playground.evo.detail.noPatch')}</p>
        )}
        <div className="pg-detail-flags">
          <span className={`pg-badge ${card.inTable ? 'pg-badge-intable' : 'pg-badge-outtable'}`}>
            {E.t(card.inTable ? 'playground.evo.detail.inTable' : 'playground.evo.detail.outTable')}
          </span>
          {card.hardGate && (
            <span className="pg-badge pg-badge-hard">{E.t('playground.evo.detail.hardGate')}</span>
          )}
          <span className="pg-badge pg-badge-src">
            {E.t(card.proposalSource === 'llm' ? 'playground.evo.detail.llm' : 'playground.evo.detail.template')}
          </span>
          {card.predictedGainPp != null && (
            <span className="pg-badge pg-badge-pred">
              {E.t('playground.evo.detail.predicted', { n: card.predictedGainPp })}
            </span>
          )}
        </div>
      </div>

      <div className="pg-detail-section">
        <div className="pg-detail-label">{E.t('playground.evo.detail.evidence')}</div>
        {phase === 'screening' && (
          <div className="pg-evidence-empty pg-evidence-run">{E.t('playground.evo.detail.screening')}</div>
        )}
        {f ? <FalsificationView f={f} /> : phase !== 'screening' ? (
          <div className="pg-evidence-empty">{E.t('playground.evo.detail.noEvidence')}</div>
        ) : null}
        {mutation && <GateView gate={gate} status={gateStatus} />}
        {card.status === 'applied' && gateStatus === 'failed' && (
          <div className="pg-falsify pg-falsify-bad">{E.t('playground.evo.detail.gateFailedAfterApply')}</div>
        )}
      </div>

      {(card.llmPrompt || card.llmOutput) && (
        <details className="pg-detail-trace">
          <summary>{E.t('playground.evo.detail.trace')}</summary>
          {card.llmPrompt && (
            <details>
              <summary>{E.t('playground.evo.detail.prompt')}</summary>
              <pre>{card.llmPrompt}</pre>
            </details>
          )}
          {card.llmOutput && (
            <details>
              <summary>{E.t('playground.evo.detail.raw')}</summary>
              <pre>{card.llmOutput}</pre>
            </details>
          )}
        </details>
      )}

      <div className="pg-detail-actions">
        {canApply ? (
          <button className="primary" onClick={() => void onApply(card, 'manual')} disabled={busy}>
            {busy
              ? E.t('playground.evo.detail.running')
              : E.t(f ? 'playground.evo.detail.reverify' : 'playground.evo.detail.runApply')}
          </button>
        ) : card.status === 'applied' ? (
          <span className="pg-action-note">{E.t('playground.evo.detail.appliedNote')}</span>
        ) : null}
        {!hardHuman && canApply && (
          <button onClick={() => void onApply(card, 'auto')} disabled={busy}>
            {E.t('playground.evo.detail.letAuto', { n: level })}
          </button>
        )}
        {mutation && (
          <button onClick={() => void onGate(mutation.commitId)} disabled={busy || gateStatus === 'running'}>
            {E.t(gateStatus === 'running'
              ? 'playground.evo.detail.gateRunning'
              : 'playground.evo.detail.gateRun')}
          </button>
        )}
        {card.verdict === 'needs-human' && (
          <span className="pg-action-note pg-action-warn">{E.t('playground.evo.detail.humanWarn')}</span>
        )}
      </div>
    </div>
  )
}

function ChangePreview({ card }: { card: ChangeCard }) {
  const E = useEvoI18n()
  const middleware = card.middlewareDiff ? Object.entries(card.middlewareDiff) : []
  const mounts = card.mountDiff ? Object.entries(card.mountDiff) : []
  const showPrompt = !!(card.promptDiff?.guides || card.promptDiff?.guideStyle)
  const value = (v: unknown) => (typeof v === 'object' ? JSON.stringify(v) : String(v))

  return (
    <div className="pg-diff">
      {showPrompt && (
        <div className="pg-diff-guide">
          <span>{E.t('playground.evo.diff.guidance')}</span>
          {card.promptDiff?.guides && <p>{card.promptDiff.guides}</p>}
          {card.promptDiff?.guideStyle && (
            <div className="pg-diff-line">
              <span>{E.t('playground.evo.diff.guideStyle')}</span>
              <code>{card.promptDiff.guideStyle}</code>
            </div>
          )}
        </div>
      )}
      {middleware.length > 0 && (
        <div className="pg-diff-table-wrap">
          <div className="pg-diff-table-title">{E.t('playground.evo.diff.harness')}</div>
          <table className="pg-diff-table">
            <tbody>
              {middleware.map(([k, v]) => (
                <tr key={k}>
                  <td>{humanField(k)}</td>
                  <td><code>{value(v)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {mounts.length > 0 && (
        <div className="pg-diff-table-wrap">
          <div className="pg-diff-table-title">{E.t('playground.evo.diff.mounts')}</div>
          <table className="pg-diff-table">
            <tbody>
              {mounts.map(([k, v]) => (
                <tr key={k}>
                  <td>{humanField(k)}</td>
                  <td><code>{value(v)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function VersionTimeline({
  state,
  busy,
  onRollback,
}: {
  state: EvoState
  busy: string | null
  onRollback: (g: EvoGeneration) => void
}) {
  const E = useEvoI18n()
  const gens = [...state.generations].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const current = gens.find((g) => g.generationId === state.currentGenerationId) ?? null
  const cardById = new Map(state.cards.map((c) => [c.cardId, c]))
  const clusterById = new Map(state.clusters.map((c) => [c.clusterId, c]))
  const labelOf = (g: EvoGeneration) => {
    const card = g.cardId ? cardById.get(g.cardId) ?? null : null
    const cluster = card ? clusterById.get(card.clusterId) ?? null : null
    return E.generationLabel(g, card, cluster)
  }

  return (
    <section className="pg-versions">
      <div className="pg-versions-head">
        <div>
          <h3>{E.t('playground.evo.versions.title')}</h3>
          <p>{E.t('playground.evo.versions.desc')}</p>
        </div>
        <span className="pg-version-current">
          {E.t('playground.evo.versions.current')}
          <span>{current ? labelOf(current) : E.t('playground.evo.noVersion')}</span>
        </span>
      </div>
      {gens.length === 0 ? (
        <p className="faint" style={{ margin: 0 }}>{E.t('playground.evo.versions.empty')}</p>
      ) : (
        <ol className="pg-version-track">
          {gens.map((g, i) => {
            const isCurrent = g.generationId === state.currentGenerationId
            const label = labelOf(g)
            return (
              <li key={g.generationId} className={`pg-version ${isCurrent ? 'current' : ''}`}>
                <div className="pg-version-rail"><span className="pg-version-dot" /></div>
                <div className="pg-version-card">
                  <div className="pg-version-top">
                    <span className="pg-version-num">v{i}</span>
                    <span className="pg-version-source">
                      {E.t(g.source === 'base' ? 'playground.evo.versions.base' : 'playground.evo.versions.evolved')}
                    </span>
                  </div>
                  <b title={label}>{label}</b>
                  <span className="pg-version-time">{fmtStamp(g.createdAt) ?? '—'}</span>
                  {isCurrent ? (
                    <span className="pg-version-badge">{E.t('playground.evo.versions.badge')}</span>
                  ) : (
                    <button className="chip" disabled={busy != null} onClick={() => void onRollback(g)}>
                      {E.t('playground.evo.versions.rollback')}
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}

/**
 * §7.2④ side-by-side race: shows every candidate that entered the race, what
 * it scored on the held-out gate set, what it cost, whether it sits on the
 * (success ↑, cost ↓) frontier, and which one won. Without this the "Pareto 择优"
 * claim would be an uncheckable tie-break.
 */
function RacePanel({
  job,
  cards,
  clusters,
  onApply,
}: {
  job: EvoRaceJob | null
  cards: ChangeCard[]
  clusters: EvoCluster[]
  onApply: (card: ChangeCard, mode: 'manual' | 'auto') => void
}) {
  const E = useEvoI18n()
  if (!job) return null
  const race: EvoRace | null = job.race
  const cardById = new Map(cards.map((c) => [c.cardId, c]))
  const clusterById = new Map(clusters.map((c) => [c.clusterId, c]))
  const titleOf = (cardId: string): string => {
    const card = cardById.get(cardId)
    if (!card) return cardId
    return E.cardTitle(card, clusterById.get(card.clusterId) ?? null)
  }
  const winner = race?.winnerCardId ? cardById.get(race.winnerCardId) ?? null : null
  return (
    <div className={`pg-race ${job.running ? 'pg-race-run' : 'pg-race-done'}`}>
      {race?.note && <div className="pg-race-note">{E.msg(race.note)}</div>}
      {race && race.entries.length > 0 && (
        <div className="pg-race-table-wrap">
          <table className="pg-race-table">
            <thead>
              <tr>
                <th>{E.t('playground.evo.race.candidate')}</th>
                <th>{E.t('playground.evo.race.surface')}</th>
                <th>{E.t('playground.evo.race.gateSuccess')}</th>
                <th>{E.t('playground.evo.race.gateLift')}</th>
                <th>{E.t('playground.evo.race.regressed')}</th>
                <th>{E.t('playground.evo.race.cost')}</th>
                <th>{E.t('playground.evo.race.pareto')}</th>
                <th>{E.t('playground.evo.race.outcome')}</th>
              </tr>
            </thead>
            <tbody>
              {race.entries.map((e) => {
                const isWinner = e.cardId === race.winnerCardId
                return (
                  <tr key={e.cardId} className={isWinner ? 'pg-race-win' : ''}>
                    <td className="pg-race-title">{titleOf(e.cardId)}</td>
                    <td>{E.surface(e.surface)}</td>
                    <td>
                      {e.dropped === null
                        ? `${e.baselinePassPp}% → ${e.candidatePassPp}%`
                        : '—'}
                    </td>
                    <td>{e.dropped === null ? `${e.gateLiftPp >= 0 ? '+' : ''}${e.gateLiftPp}pp` : '—'}</td>
                    <td>{e.dropped === null ? e.regressed : '—'}</td>
                    <td>
                      {e.dropped === null
                        ? e.costAxis === 'usd'
                          ? fmtUsd(e.avgCostUsd)
                          : e.costAxis === 'token'
                            ? E.t('playground.evo.race.tokenProxy', { n: Math.round(e.cost) })
                            : `${Math.round(e.cost)} tok`
                        : '—'}
                    </td>
                    <td>
                      {e.onFrontier
                        ? E.t('playground.evo.race.frontier')
                        : e.dropped === null
                          ? E.t('playground.evo.race.dominated')
                          : '—'}
                    </td>
                    <td className="pg-race-verdict">
                      {isWinner ? E.t('playground.evo.race.winner') : e.dropped ? E.msg(e.dropped) : ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {race && race.awaitingHuman && winner && (
        <div className="pg-race-actions">
          <span>{E.t('playground.evo.race.awaiting')}</span>
          <button
            className="primary"
            onClick={() => void onApply(winner, 'manual')}
            disabled={winner.status === 'screening' || winner.status === 'applied'}
          >
            {E.t('playground.evo.race.applyWinner')}
          </button>
        </div>
      )}
    </div>
  )
}

function GateView({ gate, status }: { gate: NonNullable<EvoMutation['gate']> | null; status: string }) {
  const E = useEvoI18n()
  if (status === 'idle') return null
  if (status === 'running') {
    return <div className="pg-falsify pg-falsify-running">{E.t('playground.evo.gate.running')}</div>
  }
  if (!gate) return <div className="pg-falsify pg-falsify-bad">{E.t('playground.evo.gate.execError')}</div>
  // `error` here means "some runs never answered", not "no verdict". When the
  // pass still produced numbers, show them — a partial pass is a real verdict on
  // the pairs that answered, and hiding it would bury a regression.
  const hasVerdict = gate.gateTaskIds.length > 0 && gate.repeats > 0 && gate.gateTaskIds.some((id) => id !== '')
  if (gate.error && !hasVerdict) {
    return (
      <div className="pg-falsify pg-falsify-bad">
        <div>
          <b>{E.t('playground.evo.gate.noVerdict')}</b>
          {E.msg(gate.error)}
        </div>
        <div className="pg-falsify-regress">{E.t('playground.evo.gate.noVerdictNote')}</div>
      </div>
    )
  }
  const ok = status === 'passed'
  const sample = hasVerdict ? gate.gateTaskIds.length * gate.repeats : 0
  const gateUnstable = gate.unstable ?? []
  const gateHard = gate.hardRegressions ?? []
  return (
    <div className={`pg-falsify ${ok ? 'pg-falsify-good' : 'pg-falsify-bad'}`}>
      {gate.error && (
        <div className="pg-falsify-regress">
          <b>{E.t('playground.evo.gate.partial')}</b>
          {E.msg(gate.error)}
        </div>
      )}
      <div>
        <b>{E.t('playground.evo.gate.label')}</b>
        {E.t('playground.evo.gate.stat', {
          b: gate.baselinePassPp,
          c: gate.candidatePassPp,
          l: gate.gateLiftPp,
          r: gate.regressed.length,
          f: gate.fixed.length,
        })}
        {gateUnstable.length > 0 && ` ${E.t('playground.evo.gate.unstable', { n: gateUnstable.length })}`}
      </div>
      <div className="faint">
        {E.t('playground.evo.gate.sample', {
          r: gate.repeats,
          n: sample,
          tokens: gate.avgTokens ?? '—',
          cost: fmtUsd(gate.avgCostUsd),
          time: gate.avgLatencyMs ? `${Math.round(gate.avgLatencyMs / 1000)}s` : '—',
        })}
      </div>
      {sample <= DEMO_GATE_SAMPLES && (
        <div className="faint">
          {E.t('playground.evo.gate.demo', {
            n: sample,
            tasks: gate.gateTaskIds.length,
            reps: gate.repeats,
          })}
        </div>
      )}
      {gateUnstable.length > 0 && (
        <div className="faint">
          {E.t('playground.evo.gate.unstableList', { list: gateUnstable.join(', ') })}
        </div>
      )}
      {gateHard.length > 0 && (
        <div className="pg-falsify-regress">
          {gateHard.map((h) => `${h.taskId} — ${h.reason}`).join('；')}
        </div>
      )}
      {gate.regressed.length > 0 && (
        <div className="pg-falsify-regress">
          {E.t('playground.evo.gate.regressedList', { list: gate.regressed.join(', ') })}
        </div>
      )}
      {gate.fixed.length > 0 && (
        <div className="pg-falsify-rescue">
          {E.t('playground.evo.gate.fixedList', { list: gate.fixed.join(', ') })}
        </div>
      )}
    </div>
  )
}

function FalsificationView({ f }: { f: NonNullable<EvoMutation['falsification']> }) {
  const E = useEvoI18n()
  const ci = f.relLift95 == null
    ? E.t('playground.evo.falsify.ciSmall')
    : E.t('playground.evo.falsify.ci', { n: f.relLift95 })
  const unanswered = f.incomplete ?? []
  const unstable = f.unstable ?? []
  const hardRegressions = f.hardRegressions ?? []
  const repeats = f.screenRepeats ?? SCREEN_REPEATS
  const runsPerSlot = RUNS_PER_SLOT * repeats
  const stamp = fmtStamp(f.at)
  return (
    <div className={`pg-falsify ${unanswered.length > 0 || hardRegressions.length > 0 ? 'pg-falsify-bad' : f.regressed.length > 0 ? 'pg-falsify-bad' : f.rescued.length > 0 ? 'pg-falsify-good' : ''}`}>
      <div>
        <b>
          {stamp
            ? E.t('playground.evo.falsify.labelAt', { stamp })
            : E.t('playground.evo.falsify.label')}
        </b>
        {E.t('playground.evo.falsify.stats', {
          r: f.rescued.length,
          g: f.regressed.length,
          s: f.stillFailed.length,
          n: f.netLiftPp ?? '—',
        })}
        {unanswered.length > 0 && ` ${E.t('playground.evo.falsify.unanswered', { n: unanswered.length })}`}
        {unstable.length > 0 && ` ${E.t('playground.evo.falsify.unstable', { n: unstable.length })}`}
      </div>
      {f.screened * runsPerSlot <= DEMO_SCREEN_SIZE && (
        <div className="faint">
          {E.t('playground.evo.falsify.demo', {
            n: f.screened,
            runs: f.screened * runsPerSlot,
            repeat: E.t(
              repeats > 1 ? 'playground.evo.falsify.demoRepeat' : 'playground.evo.falsify.demoOne',
              { n: repeats },
            ),
          })}
        </div>
      )}
      {unanswered.length > 0 && (
        <div className="pg-falsify-regress">
          {E.t('playground.evo.falsify.unansweredList', { list: unanswered.join(', ') })}
        </div>
      )}
      {unstable.length > 0 && (
        <div className="faint">
          {E.t('playground.evo.falsify.unstableList', { list: unstable.join(', ') })}
        </div>
      )}
      {hardRegressions.length > 0 && (
        <div className="pg-falsify-regress">
          {hardRegressions.map((h) => `${h.taskId} — ${h.reason}`).join('；')}
        </div>
      )}
      <div className="faint">
        {E.t('playground.evo.falsify.meta', {
          ci,
          tokens: f.avgTokens ?? '—',
          cost: fmtUsd(f.avgCostUsd),
          time: f.avgLatencyMs ? `${Math.round(f.avgLatencyMs / 1000)}s` : '—',
        })}
      </div>
      {f.rescued.length > 0 && (
        <div className="pg-falsify-rescue">
          {E.t('playground.evo.falsify.rescuedList', { list: f.rescued.join(', ') })}
        </div>
      )}
      {f.regressed.length > 0 && (
        <div className="pg-falsify-regress">
          {E.t('playground.evo.falsify.regressedList', { list: f.regressed.join(', ') })}
        </div>
      )}
    </div>
  )
}
