// M4 deterministic falsification via real re-runs (PRISM §7.2④).
//
// A candidate is screened on the cluster's failed repair tasks (rescue signal),
// then guarded by a few baseline-passing tasks (regression signal). Everything
// is a genuine runner execution against the configured LLM — the gain estimate
// is not faked. The 15-task gate set is a separate pass (×repeats, design §3.2).
import type {
  ChangeCard,
  EvoProfile,
  FalsificationResult,
  GateResult,
  PgMounts,
  RunDetail,
} from '../../shared/playground'
import { EVO_PROFILES, GATE_TASK_EXCLUDED, SCREEN_TASK_EXCLUDED, gateTasksFor } from '../../shared/playground'
import { createRun, executeRun } from './runner'
import { getRunDetail } from './liveDb'
import { getTask, loadEvalSet } from './evalset'
import { pairedGain, gateStats, type GatePair, type Pair } from './gainEstimator'
import { estimateCostUsd } from './costTable'
import { fingerprint, type HarnessConfig } from '../../shared/config'
import type { EvoGeneration } from '../../shared/playground'
import type { ScoreResult } from '../../shared/playground'

/**
 * Paired runs per screened task.
 *
 * The screen used to run each task exactly once per half, so a single flipped
 * sample decided the card's fate. Two is the minimum that lets a flip be told
 * from a coin flip: `classifyPaired` names a rescue or a regression only when
 * the flip reproduces on every pair the slot was given.
 */
const SCREEN_REPEATS = 2
/** Seed spacing between the repeats of one slot (retries use +1000 per attempt). */
const SCREEN_REPEAT_OFFSET = 5000

/** Maximum baseline-passing guard tasks re-run per card (regression guard). */
const GUARD_LIMIT = 3
/**
 * Failed-task screening subset (PRISM §7.2④ "repair 失败子集筛"): the card is
 * first screened on the most recent distinct failed tasks, not every failed
 * run. The 15-task gate pass is the heavier verification.
 */
const SCREEN_LIMIT = 6

/** Cap repeats so a misconfigured override cannot fan out unboundedly. */
export const GATE_REPEATS_MAX = 5
/** Suggested k when temperature > 0 (design §3.2). */
export const GATE_REPEATS_SUGGESTED = 3

/**
 * §3.2 repeats: temperature>0 → suggested 3; temperature=0 → 1.
 * Explicit override wins (clamped to [1, GATE_REPEATS_MAX]).
 */
export function gateRepeatsFor(temperature: number, override?: number): number {
  if (override != null && Number.isFinite(override)) {
    return Math.max(1, Math.min(GATE_REPEATS_MAX, Math.floor(override)))
  }
  return temperature > 0 ? GATE_REPEATS_SUGGESTED : 1
}

/** Materialize a card's candidate config + mounts from a parent generation. */
export function applyCardToConfig(
  card: ChangeCard,
  baseConfig: HarnessConfig,
  baseMounts: PgMounts,
): { config: HarnessConfig; mounts: PgMounts } {
  const config: HarnessConfig = { ...baseConfig, ...(card.middlewareDiff ?? {}) }
  const mounts: PgMounts = { ...baseMounts, ...(card.mountDiff ?? {}) }

  // prompt surface: escalate the guide pack and inject the LLM wording.
  if (card.promptDiff) {
    const style = card.promptDiff.guideStyle
    if (style === 'domain-checklist') config.guides = 'domain-checklist'
    else if (style === 'style-rules' && config.guides === 'none') config.guides = 'style-rules'
    if (card.promptDiff.guides) mounts.customGuideText = card.promptDiff.guides
  }
  return { config, mounts }
}

const GUIDE_RANK: Record<string, number> = { none: 0, 'style-rules': 1, 'domain-checklist': 2 }

export function candidateFingerprint(config: HarnessConfig): string {
  return fingerprint(config)
}

interface RunOutcome {
  taskId: string
  success: boolean
  tokens: number | null
  latencyMs: number | null
  costUsd: number | null
  runId: string
  /**
   * Set when the run produced no answer at all (provider/network error, budget
   * cutoff). A `success: false` with no reason is a real scored failure; with a
   * reason it is an unanswered task and carries no signal about the candidate.
   */
  unanswered: string | null
  /**
   * Reason a DETERMINISTIC check failed on this run — a leak, an injection that
   * landed, a statute that does not exist — or null when the run was clean.
   *
   * Read off the detector rather than the judge's reading on purpose. The
   * reading can call both halves of a pair "failed" while the parent's answer
   * was clean and the candidate's printed a citizen ID number and a bank
   * account: the leak is a hard fact, the reading is an opinion, and only the
   * fact can be trusted to compare the two halves.
   */
  hardFail: string | null
}

/** Deterministic-check state of one run, for the paired comparison. */
function hardFailOf(detail: { verdict: ScoreResult | null }): string | null {
  const v = detail.verdict
  if (!v) return null
  const sec = v.securityChecks.filter((c) => !c.passed).map((c) => `安全门(${c.kind})：${c.detail}`)
  const art = v.articleChecks
    .filter((a) => !a.articleExists || a.assertion === 'unsupported' || a.assertion === 'citation_unreachable')
    .map((a) => `法条核验(${a.law}${a.article ?? ''})：${a.detail}`)
  const all = [...sec, ...art]
  return all.length ? all.slice(0, 3).join('；') : null
}

async function runCandidate(
  taskId: string,
  config: HarnessConfig,
  mounts: PgMounts,
  provider: { providerId?: string; model?: string },
  seed: number,
  temperature = 0.2,
): Promise<RunOutcome | { error: string }> {
  const task = getTask(taskId)
  if (!task) return { error: `task not found: ${taskId}` }
  const made = createRun({
    task,
    config,
    mounts,
    presetId: null,
    providerId: provider.providerId,
    model: provider.model,
    temperature,
    seed,
    source: 'live',
  })
  if ('error' in made) return { error: made.error }
  // Run to completion synchronously so the paired verdict is ready before we
  // decide the card's fate.
  await executeRun(made.runId)
  const detail = getRunDetail(made.runId)
  if (!detail) return { error: `run missing after execute: ${made.runId}` }
  const costUsd = estimateCostUsd({
    providerId: detail.provider?.providerId ?? provider.providerId,
    model: detail.provider?.model ?? provider.model,
    tokens: detail.tokens,
  })
  // status 'error' means the model never produced an answer to score. Reading
  // its empty verdict as "failed" would blame the candidate for a broken pipe.
  const unanswered = detail.status === 'error' ? (detail.error ?? 'run errored') : null
  return {
    taskId,
    success: detail.success === true,
    tokens: detail.tokens,
    latencyMs: detail.latencyMs,
    costUsd,
    runId: made.runId,
    unanswered,
    hardFail: hardFailOf(detail),
  }
}

function dedupByTask(runs: RunDetail[]): RunDetail[] {
  const seen = new Map<string, RunDetail>()
  for (const r of runs) {
    const prev = seen.get(r.taskId)
    if (!prev || (r.createdAt > prev.createdAt)) seen.set(r.taskId, r)
  }
  return [...seen.values()]
}

/**
 * Provider-call ceiling for this file, not a task ceiling: a screen slot and a
 * gate pair are both TWO live runs (parent half + candidate half), and both
 * halves are now fired together instead of one after the other. Halving the loop
 * limit (see the two derived constants below) keeps the number of calls in
 * flight exactly where it was while cutting the wall clock of a pair in half.
 *
 * A screen is at most SCREEN_LIMIT + GUARD_LIMIT = 9 slots. Each run is one full
 * agent run and the runner budgets every run from its own start, so parallel
 * runs do not steal each other's budget. The provider's shared quota is enforced
 * centrally as a rate limit (providerQuota.ts), so this cap no longer has to
 * stand in for the quota — it only has to keep the process from opening more
 * calls than it can finish: 16 in flight ≈ two full screens' worth, and the
 * pacer spaces starts out against the provider's real ceiling.
 */
const FALSIFY_CONCURRENCY = Number(process.env['HWT_FALSIFY_CONCURRENCY'] ?? 16)

/**
 * Same provider ceiling for the held-out gate. Each job is a pair of runs fired
 * together, so the pair limit is half the call ceiling.
 */
const GATE_PAIRS_CONCURRENCY = Number(process.env['HWT_GATE_PAIR_CONCURRENCY'] ?? 16)

/** Screen slots in flight = call ceiling / 2 (both halves of a slot fire together). */
const SCREEN_SLOTS_IN_FLIGHT = Math.max(1, Math.floor(FALSIFY_CONCURRENCY / 2))

/** Gate pairs in flight = call ceiling / 2 (both halves of a pair fire together). */
const GATE_PAIRS_IN_FLIGHT = Math.max(1, Math.floor(GATE_PAIRS_CONCURRENCY / 2))

/**
 * How many times a task that produced no answer is re-run before the whole
 * screening is declared indeterminate. A provider/network error carries no
 * signal about the candidate, so it must not be counted as a failure — but
 * silently dropping the task would let a card pass on a thinner sample than
 * promised, so a task that keeps failing is retried first.
 */
const INCOMPLETE_RETRIES = Number(process.env['HWT_FALSIFY_INCOMPLETE_RETRIES'] ?? 2)

/**
 * Map with a bounded number of in-flight tasks, preserving input order in the
 * result. Unlike `Promise.all` over a plain map, this never has more than
 * `limit` provider calls outstanding at once.
 */
async function mapBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const width = Math.max(1, Math.min(limit, items.length))
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: width }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return out
}

export interface FalsifyInput {
  card: ChangeCard
  baseConfig: HarnessConfig
  baseMounts: PgMounts
  /** The cluster's failed runs (baseline fail). */
  failedRuns: RunDetail[]
  /** Baseline-passing repair runs to guard against regressions. */
  passingRuns: RunDetail[]
  provider: { providerId?: string; model?: string }
  /** Run profile: shrinks the sample (demo) or keeps the measured口径. */
  profile?: EvoProfile
}

export interface ScreenSlot {
  taskId: string
  /** Same seed for both halves of this slot, so the pair differs only by the card. */
  seed: number
}

/**
 * What a screen will execute: one slot per task, each carrying the seed shared by
 * its two halves. Rescue tasks come first, then guards, so the enumeration — and
 * therefore every seed — is stable across runs.
 */
export function buildScreenSlots(sel: { failed: { taskId: string }[]; guards: { taskId: string }[] }): ScreenSlot[] {
  return [
    ...sel.failed.map((r) => r.taskId),
    ...sel.guards.map((r) => r.taskId),
  ].map((taskId, i) => ({ taskId, seed: 9000 + i + 1 }))
}

/** Screen + guard a candidate. Returns the paired falsification result. */
export async function falsifyCard(input: FalsifyInput): Promise<FalsificationResult | { error: string }> {
  const { card, baseConfig, baseMounts } = input
  const { config, mounts } = applyCardToConfig(card, baseConfig, baseMounts)
  const spec = EVO_PROFILES[input.profile ?? 'full']

  // Most recent failed attempt per task, newest first, then the screening cap.
  // Permanently-excluded tasks are dropped before the cap, not after: the cap
  // must not be spent on a slot that will never be filled.
  const failed = dedupByTask([...input.failedRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    .filter((r) => !SCREEN_TASK_EXCLUDED.includes(r.taskId))
    .slice(0, spec.screenFailed)
  // Guard tasks are deduped against the whole cluster's task list, not just the
  // screened slice: a task cannot both rescue and regress in one screen, even if
  // it had several runs and only some made the cut.
  const guardPool = dedupByTask(input.passingRuns)
    .filter((r) => !SCREEN_TASK_EXCLUDED.includes(r.taskId))
    .filter((r) => !input.failedRuns.some((f) => f.taskId === r.taskId))
  const guards = guardPool.slice(0, spec.screenGuards)

  // Every slot is a PAIR, and both halves are executed live right now.
  //
  // The baseline used to be a stored run picked out of the history. That is not
  // a valid comparison: the stored run carries whatever guidance text and mounts
  // were live at the time, and the current generation has since changed those. A
  // paired screen then varies two things at once (the candidate's change AND the
  // accumulated drift), so it cannot attribute the difference to either. It was
  // observed in practice: S3 measured 0.18 against a stored baseline and 0.968
  // against the same config minutes later — the baseline was noise, not signal.
  //
  // Both halves now run the parent config and the candidate config with the SAME
  // seed, so the only difference between the two runs is the card's own diff.
  const plan = buildScreenSlots({ failed, guards })

  // Both halves of a slot are fired together. The pair still differs by exactly
  // one thing (parent config vs candidate config, same task and same seed), but
  // the slot now costs one model run of wall clock instead of two sequential
  // ones. The loop limit below is halved for that reason, so the peak number of
  // provider calls is unchanged.
  const runSlot = async (taskId: string, seed: number) => {
    const [base, cand] = await Promise.all([
      runCandidate(taskId, baseConfig, baseMounts, input.provider, seed),
      runCandidate(taskId, config, mounts, input.provider, seed),
    ])
    if ('error' in base) return { base, cand: base }
    return { base, cand }
  }

  // Every slot runs the profile's paired repetitions at distinct seeds. Both
  // halves of a repetition share its seed, so a repetition is still a clean
  // comparison; the repetitions are what let classifyPaired require a flip to
  // reproduce before naming it. The demo profile drops to one repetition, which
  // is affordable because the judge no longer re-derives the point checks from
  // the answer's wording (see buildJudgeState) — the reading stopped swinging.
  const screenRepeats = spec.screenRepeats ?? SCREEN_REPEATS
  const jobs: { taskId: string; seed: number; slot: number }[] = []
  plan.forEach((p, slot) => {
    for (let rep = 0; rep < screenRepeats; rep += 1) {
      jobs.push({ taskId: p.taskId, seed: p.seed + rep * SCREEN_REPEAT_OFFSET, slot })
    }
  })

  const outcomes = await mapBounded(jobs, SCREEN_SLOTS_IN_FLIGHT, (j) => runSlot(j.taskId, j.seed))

  // A run that produced no answer tells us nothing about the candidate. Re-run
  // just those slots, up to the retry cap, before giving up — a flaky provider
  // must not be able to decide whether a card is good. The fresh seed shifts both
  // halves of the pair together, so the pairing survives the retry.
  const slots = outcomes.map((out, i) => ({ out, i }))
  const slotUnanswered = (o: { base: RunOutcome | { error: string }; cand: RunOutcome | { error: string } }): boolean =>
    ('error' in o.base ? true : o.base.unanswered !== null) ||
    ('error' in o.cand ? true : o.cand.unanswered !== null)
  for (let attempt = 1; attempt <= INCOMPLETE_RETRIES; attempt++) {
    const unanswered = slots.filter((s) => slotUnanswered(s.out))
    if (unanswered.length === 0) break
    const redone = await mapBounded(unanswered, SCREEN_SLOTS_IN_FLIGHT, (s) => {
      const j = jobs[s.i]!
      return runSlot(j.taskId, j.seed + 1000 * attempt)
    })
    redone.forEach((out, k) => {
      unanswered[k]!.out = out
    })
  }

  const pairs: Pair[] = []
  const newRunIds: string[] = []
  const incomplete: string[] = []
  for (const { out } of slots) {
    if ('error' in out.base) return { error: out.base.error }
    if ('error' in out.cand) return { error: out.cand.error }
    newRunIds.push(out.base.runId, out.cand.runId)
    // Either half missing its answer drops the whole repetition: half a
    // comparison says nothing about the card.
    if (out.base.unanswered || out.cand.unanswered) {
      if (!incomplete.includes(out.base.taskId)) incomplete.push(out.base.taskId)
      continue
    }
    const hardFlip = out.base.hardFail === null && out.cand.hardFail !== null
      ? `${out.cand.taskId}：改前干净、改后触发确定性检查 — ${out.cand.hardFail}`
      : null
    pairs.push({
      taskId: out.cand.taskId,
      baseline: out.base.success,
      candidate: out.cand.success,
      candidateTokens: out.cand.tokens,
      candidateLatencyMs: out.cand.latencyMs,
      candidateCostUsd: out.cand.costUsd,
      hardFlip,
      baselineClean: out.base.hardFail === null,
      candidateClean: out.cand.hardFail === null,
    })
  }

  const g = pairedGain(pairs)
  return {
    rescued: g.rescued,
    regressed: g.regressed,
    stillFailed: g.stillFailed,
    screened: g.screened,
    netLiftPp: g.netLiftPp,
    relLift95: g.relLift95,
    avgTokens: g.avgTokens,
    avgLatencyMs: g.avgLatencyMs,
    avgCostUsd: g.avgCostUsd,
    hardGateRegressed: card.hardGate && (g.regressed.length > 0 || g.hardRegressions.length > 0),
    unstable: g.unstable,
    hardRegressions: g.hardRegressions,
    newRunIds,
    incomplete,
    at: new Date().toISOString(),
    screenRepeats,
  }
}

/**
 * A card survives falsification only if it helps and never regresses — and only
 * if the screening actually saw every task it promised. Unanswered tasks make
 * the pass indeterminate: the card is neither rescued nor judged, and stays on
 * the table for another real re-run. A deterministic-check regression falsifies
 * on its own, whatever the reading says.
 */
export function falsificationPasses(r: FalsificationResult & { incomplete?: string[] }): boolean {
  return (r.incomplete?.length ?? 0) === 0
    && r.regressed.length === 0
    && !r.hardGateRegressed
    && r.hardRegressions.length === 0
    && r.rescued.length > 0
}

export interface GateVerifyOpts {
  provider: { providerId?: string; model?: string }
  /** Override §3.2 repeats; otherwise derived from temperature. */
  repeats?: number
  /** Gate run temperature (also drives default repeats). Default 0.2. */
  temperature?: number
  /** Run profile: shrinks the held-out sample (demo) or keeps it. */
  profile?: EvoProfile
}

export interface GateConfigPair {
  config: HarnessConfig
  mounts: PgMounts
}

/**
 * §7.2④ held-out gate full verification on raw configs (no generation required).
 * Used by the top-2 Pareto race before a winner is committed to the version tree.
 */
export async function gateVerifyConfigs(
  candidate: GateConfigPair,
  parent: GateConfigPair,
  opts: GateVerifyOpts,
): Promise<GateResult | { error: string }> {
  const temperature = opts.temperature ?? 0.2
  const profile = opts.profile ?? 'full'
  const spec = EVO_PROFILES[profile]
  // The profile pins the count when it has one (demo → ×2). The §3.2 rule
  // (temperature>0 → 3, temperature 0 → 1) plus the operator's override apply only
  // when it does not. The UI must therefore omit `repeats` in demo mode — a repeat
  // select always carries a number, and letting it through would silently defeat
  // the preset, which is exactly what happened on the first demo gate run.
  const repeats = spec.gateRepeats != null && opts.repeats == null
    ? spec.gateRepeats
    : gateRepeatsFor(temperature, opts.repeats)
  const wantedIds = gateTasksFor(profile)
  const gateTasks = loadEvalSet().tasks.filter(
    (t) => t.split === 'gate'
      && !GATE_TASK_EXCLUDED.includes(t.id)
      && (!wantedIds || wantedIds.includes(t.id)),
  )
  if (gateTasks.length === 0) return { error: 'no held-out tasks left to run after exclusions' }
  const baselineRunIds: string[] = []
  const newRunIds: string[] = []
  const pairs: GatePair[] = []

  // One entry per (task, repeat), enumerated in the same order as before so the
  // seed of a given pair is unchanged. Baseline and candidate of a pair stay
  // adjacent and share the seed pair, so a pair is always the same comparison.
  const jobs: { taskId: string; rep: number; idx: number }[] = []
  let idx = 0
  for (const task of gateTasks) {
    for (let rep = 0; rep < repeats; rep += 1) {
      idx += 1
      jobs.push({ taskId: task.id, rep, idx })
    }
  }

  // Same seeds as before: the paired baseline/candidate share a repeat's seed
  // and differ by one seed step (design §3.2 ×repeats). The two halves now fire
  // together, so a pair costs one model run of wall clock instead of two; the
  // loop limit below is halved to hold the provider-call ceiling.
  const runPair = async (job: { taskId: string; rep: number; idx: number }): Promise<{
    b: RunOutcome | { error: string }
    c: RunOutcome | { error: string } | null
  }> => {
    const seedBase = 9200 + job.idx * 10 + job.rep
    const [b, c] = await Promise.all([
      runCandidate(job.taskId, parent.config, parent.mounts, opts.provider, seedBase, temperature),
      runCandidate(job.taskId, candidate.config, candidate.mounts, opts.provider, seedBase + 1, temperature),
    ])
    if ('error' in b) return { b, c: null }
    return { b, c }
  }

  const results = await mapBounded(jobs, GATE_PAIRS_IN_FLIGHT, runPair)

  // An unanswered run carries no signal. Re-run just those slots (both sides of
  // the pair, so the comparison stays paired) before declaring the gate failed
  // for the wrong reason.
  const slots = results.map((r, i) => ({ r, i }))
  const unansweredIn = (r: { b: RunOutcome | { error: string }; c: RunOutcome | { error: string } | null }): boolean =>
    ('error' in r.b ? true : r.b.unanswered !== null) ||
    (r.c !== null && ('error' in r.c ? true : r.c.unanswered !== null))
  for (let attempt = 1; attempt <= INCOMPLETE_RETRIES; attempt++) {
    const unanswered = slots.filter((s) => unansweredIn(s.r))
    if (unanswered.length === 0) break
    const redone = await mapBounded(unanswered, GATE_PAIRS_IN_FLIGHT, (s) => runPair(jobs[s.i]!))
    redone.forEach((r, k) => {
      unanswered[k]!.r = r
    })
  }

  const unansweredTasks: string[] = []
  for (const { r } of slots) {
    if ('error' in r.b) return { error: r.b.error }
    if (r.c && 'error' in r.c) return { error: r.c.error }
    baselineRunIds.push(r.b.runId)
    if (r.b.unanswered) unansweredTasks.push(`${r.b.taskId} (baseline)`)
    if (!r.c) continue
    newRunIds.push(r.c.runId)
    if (r.c.unanswered) {
      unansweredTasks.push(`${r.c.taskId} (candidate)`)
      continue
    }
    pairs.push({
      taskId: r.c.taskId,
      baseline: r.b.success,
      candidate: r.c.success,
      candidateTokens: r.c.tokens,
      candidateLatencyMs: r.c.latencyMs,
      candidateCostUsd: r.c.costUsd,
      hardFlip: r.b.hardFail === null && r.c.hardFail !== null
        ? `${r.c.taskId}：改前干净、改后触发确定性检查 — ${r.c.hardFail}`
        : null,
      baselineClean: r.b.hardFail === null,
      candidateClean: r.c.hardFail === null,
    })
  }

  if (unansweredTasks.length > 0) {
    // 不作废整轮：没答上的槽位被剔掉，用剩下的配对出结论。一道题反复超时不
    // 该把已经跑完的几十次真跑全部作废——回归检测靠的是"哪题从通过掉到失败"，
    // 少一题不影响其余各题的判断，只是分母变小，而且缺的那题按未答上记录、
    // 不当作通过。
    return {
      ...gateStats(pairs),
      gateTaskIds: gateTasks.map((t) => t.id),
      repeats,
      baselineRunIds,
      newRunIds,
      ranAt: new Date().toISOString(),
      error: `partial: ${unansweredTasks.length} run(s) produced no answer after retries (${unansweredTasks.slice(0, 8).join(', ')}); this verdict uses only the pairs that answered.`,
    }
  }

  const s = gateStats(pairs)
  return {
    gateTaskIds: gateTasks.map((t) => t.id),
    ...s,
    repeats,
    baselineRunIds,
    newRunIds,
    ranAt: new Date().toISOString(),
  }
}

/**
 * §7.2④ held-out gate full verification: re-run every gate-split task under
 * BOTH the parent and the candidate generation so the comparison is paired.
 * Heavy (2 × gate tasks × repeats) — triggered explicitly/asynchronously.
 */
export async function gateVerify(
  candidate: EvoGeneration,
  parent: EvoGeneration,
  provider: { providerId?: string; model?: string },
  opts?: { repeats?: number; temperature?: number; profile?: EvoProfile },
): Promise<GateResult | { error: string }> {
  return gateVerifyConfigs(
    { config: candidate.config, mounts: candidate.mounts },
    { config: parent.config, mounts: parent.mounts },
    { provider, repeats: opts?.repeats, temperature: opts?.temperature, profile: opts?.profile },
  )
}

export { GUIDE_RANK }
