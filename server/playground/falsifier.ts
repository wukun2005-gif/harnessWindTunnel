// M4 deterministic falsification via real re-runs (PRISM §7.2④).
//
// A candidate is screened on the cluster's failed repair tasks (rescue signal),
// then guarded by a few baseline-passing tasks (regression signal). Everything
// is a genuine runner execution against the configured LLM — the gain estimate
// is not faked. The 15-task gate set is a separate pass (×repeats, design §3.2).
import type {
  ChangeCard,
  FalsificationResult,
  GateResult,
  PgMounts,
  RunDetail,
} from '../../shared/playground'
import { createRun, executeRun } from './runner'
import { getRunDetail } from './liveDb'
import { getTask, loadEvalSet } from './evalset'
import { pairedGain, gateStats, type GatePair, type Pair } from './gainEstimator'
import { estimateCostUsd } from './costTable'
import { fingerprint, type HarnessConfig } from '../../shared/config'
import type { EvoGeneration } from '../../shared/playground'

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
  return {
    taskId,
    success: detail.success === true,
    tokens: detail.tokens,
    latencyMs: detail.latencyMs,
    costUsd,
    runId: made.runId,
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

export interface FalsifyInput {
  card: ChangeCard
  baseConfig: HarnessConfig
  baseMounts: PgMounts
  /** The cluster's failed runs (baseline fail). */
  failedRuns: RunDetail[]
  /** Baseline-passing repair runs to guard against regressions. */
  passingRuns: RunDetail[]
  provider: { providerId?: string; model?: string }
}

/** Screen + guard a candidate. Returns the paired falsification result. */
export async function falsifyCard(input: FalsifyInput): Promise<FalsificationResult | { error: string }> {
  const { card, baseConfig, baseMounts } = input
  const { config, mounts } = applyCardToConfig(card, baseConfig, baseMounts)

  // Most recent failed attempt per task, newest first, then the screening cap.
  const failed = dedupByTask([...input.failedRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    .slice(0, SCREEN_LIMIT)
  const guards = dedupByTask(input.passingRuns)
    .filter((r) => !failed.some((f) => f.taskId === r.taskId))
    .slice(0, GUARD_LIMIT)

  const pairs: Pair[] = []
  const newRunIds: string[] = []
  let idx = 0

  // Rescue screen: baseline failed.
  for (const base of failed) {
    idx += 1
    const out = await runCandidate(base.taskId, config, mounts, input.provider, 9000 + idx)
    if ('error' in out) return { error: out.error }
    newRunIds.push(out.runId)
    pairs.push({
      taskId: out.taskId,
      baseline: false,
      candidate: out.success,
      candidateTokens: out.tokens,
      candidateLatencyMs: out.latencyMs,
      candidateCostUsd: out.costUsd,
    })
  }

  // Regression guard: baseline passed.
  for (const base of guards) {
    idx += 1
    const out = await runCandidate(base.taskId, config, mounts, input.provider, 9100 + idx)
    if ('error' in out) return { error: out.error }
    newRunIds.push(out.runId)
    pairs.push({
      taskId: out.taskId,
      baseline: true,
      candidate: out.success,
      candidateTokens: out.tokens,
      candidateLatencyMs: out.latencyMs,
      candidateCostUsd: out.costUsd,
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
    hardGateRegressed: card.hardGate && g.regressed.length > 0,
    newRunIds,
  }
}

/** A card survives falsification only if it helps and never regresses. */
export function falsificationPasses(r: FalsificationResult): boolean {
  return r.regressed.length === 0 && !r.hardGateRegressed && r.rescued.length > 0
}

export interface GateVerifyOpts {
  provider: { providerId?: string; model?: string }
  /** Override §3.2 repeats; otherwise derived from temperature. */
  repeats?: number
  /** Gate run temperature (also drives default repeats). Default 0.2. */
  temperature?: number
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
  const repeats = gateRepeatsFor(temperature, opts.repeats)
  const gateTasks = loadEvalSet().tasks.filter((t) => t.split === 'gate')
  const baselineRunIds: string[] = []
  const newRunIds: string[] = []
  const pairs: GatePair[] = []
  let idx = 0

  for (const task of gateTasks) {
    for (let rep = 0; rep < repeats; rep += 1) {
      idx += 1
      // Same seed for the paired baseline/candidate within a repeat; distinct
      // seeds across repeats so variance is real (design §3.2 ×repeats).
      const seedBase = 9200 + idx * 10 + rep
      const b = await runCandidate(
        task.id, parent.config, parent.mounts, opts.provider, seedBase, temperature,
      )
      if ('error' in b) return { error: b.error }
      baselineRunIds.push(b.runId)
      const c = await runCandidate(
        task.id, candidate.config, candidate.mounts, opts.provider, seedBase + 1, temperature,
      )
      if ('error' in c) return { error: c.error }
      newRunIds.push(c.runId)
      pairs.push({
        taskId: task.id,
        baseline: b.success,
        candidate: c.success,
        candidateTokens: c.tokens,
        candidateLatencyMs: c.latencyMs,
        candidateCostUsd: c.costUsd,
      })
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
  opts?: { repeats?: number; temperature?: number },
): Promise<GateResult | { error: string }> {
  return gateVerifyConfigs(
    { config: candidate.config, mounts: candidate.mounts },
    { config: parent.config, mounts: parent.mounts },
    { provider, repeats: opts?.repeats, temperature: opts?.temperature },
  )
}

export { GUIDE_RANK }
