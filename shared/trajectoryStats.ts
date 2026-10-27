// P2 pilot statistics — same-task consistency and live-only stability.
//
// Two rules from the P2 plan are encoded here rather than in the UI:
//   1. Consistency compares a recorded reference sample with later runs of the
//      SAME task. A disagreement is a prompt to re-read the contract, never to
//      edit a number: this module only reports it.
//   2. Stability (pass^k, dominant path share) is computed for live runs only.
//      Fixture replay consistency is a different quantity and is never placed
//      side by side with live stability.
//
// Pure functions, no Node/React imports: the server feeds them readings and the
// tests feed them synthetic readings.
import type { TrajectoryCell } from './trajectory'

export const READING_BUCKETS = [
  'trusted-success', 'fluke-success', 'one-step-short', 'clear-failure', 'process-incomplete', 'unknown',
] as const
export type ReadingBucket = (typeof READING_BUCKETS)[number]

export interface PilotRunReading {
  runId: string
  taskId: string
  fingerprint: string
  configLabel: string
  createdAt: string
  source: 'live' | 'imported'
  status: string
  bucket: ReadingBucket
  cell: TrajectoryCell | null
  hardViolation: boolean
  softViolations: number
  csr: number | null
  firstDivergence: number | null
  pathSignature: string
  matchedPath: string | null
  terminalSuccess: boolean | null
  /** Judge-model result, shown beside the reading and never merged into it. */
  judgeSuccess: boolean | null
  judgeScore: number | null
  /** Required checkpoints that were known-missing (not unknown). */
  missingCheckpoints: string[]
}

/**
 * One row of the Playground pilot tab: the two readings per task, trimmed to
 * what the list shows. The full reports come from `/api/trajectory/pilot?task=`.
 */
export interface PilotTaskSummary {
  taskId: string
  contractId: string
  contractVersion: string
  runs: number
  consistency: Pick<ConsistencyReport, 'agree' | 'compared' | 'verdict' | 'suspects'>
  stability: Pick<StabilityReport, 'runs' | 'pooledPassK' | 'dominantPath' | 'dominantShare' | 'groups'>
}

export interface ConsistencyRow {
  reading: PilotRunReading
  /**
   * Same bucket as the reference sample. `null` = not comparable: an unknown
   * reading is missing evidence, not a disagreement (ADR-09), so it is left out
   * of the agreement count instead of being scored as a mismatch.
   */
  agreesCell: boolean | null
  agreesHard: boolean | null
  agreesPath: boolean | null
  /** Fields that differ — the UI shows them as the reason for the flag. */
  diffs: string[]
}

export interface ConsistencyReport {
  taskId: string
  contractId: string
  contractVersion: string
  reference: PilotRunReading | null
  rows: ConsistencyRow[]
  agree: number
  compared: number
  /** 'insufficient' when there is nothing to compare against. */
  verdict: 'consistent' | 'mixed' | 'insufficient'
  /**
   * Required checkpoints that never completed in at least half the runs. This
   * is the "the contract may be missing a checkpoint" suspect list — surfaced
   * instead of silently re-tuning the reading.
   */
  suspects: Array<{ id: string; missing: number; runs: number }>
}

function diffFields(ref: PilotRunReading, cur: PilotRunReading): string[] {
  const out: string[] = []
  if (ref.bucket !== cur.bucket) out.push('cell')
  if (ref.hardViolation !== cur.hardViolation) out.push('hardViolation')
  // Compare the DECLARED path, not the raw checkpoint walk: two runs can take
  // the same allowed path while reading different optional documents, and
  // calling that a disagreement would bury the real ones.
  if ((ref.matchedPath ?? ref.pathSignature) !== (cur.matchedPath ?? cur.pathSignature)) out.push('path')
  if (ref.firstDivergence !== cur.firstDivergence) out.push('firstDivergence')
  return out
}

/**
 * The reference sample is the earliest recorded run the contract can actually
 * read (a determinate cell or a process-incomplete reading). Falling back to the
 * earliest run when none is readable keeps the choice deterministic, and the
 * comparison then honestly reports "nothing comparable" rather than comparing
 * against an unknown.
 */
export function buildConsistency(
  readings: PilotRunReading[],
  contract: { contractId: string; version: string },
): ConsistencyReport {
  const sorted = [...readings].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId))
  const reference = sorted.find((r) => r.bucket !== 'unknown') ?? sorted[0] ?? null
  const rows: ConsistencyRow[] = reference
    ? sorted
        .filter((r) => r.runId !== reference.runId)
        .map((reading) => {
          const comparable = reference.bucket !== 'unknown' && reading.bucket !== 'unknown'
          const diffs = comparable ? diffFields(reference, reading) : []
          return {
            reading,
            agreesCell: comparable ? reading.bucket === reference.bucket : null,
            agreesHard: comparable ? reading.hardViolation === reference.hardViolation : null,
            agreesPath: comparable ? reading.pathSignature === reference.pathSignature : null,
            diffs,
          }
        })
    : []
  const comparableRows = rows.filter((r) => r.agreesCell !== null)
  const compared = comparableRows.filter((r) => r.agreesCell === true && r.agreesHard === true).length
  const missing = new Map<string, number>()
  for (const r of sorted) for (const id of r.missingCheckpoints) missing.set(id, (missing.get(id) ?? 0) + 1)
  const suspects = [...missing.entries()]
    .filter(([, n]) => sorted.length >= 2 && n / sorted.length >= 0.5)
    .map(([id, n]) => ({ id, missing: n, runs: sorted.length }))
    .sort((a, b) => b.missing - a.missing || a.id.localeCompare(b.id))
  return {
    taskId: reference?.taskId ?? '',
    contractId: contract.contractId,
    contractVersion: contract.version,
    reference,
    rows,
    agree: compared,
    compared: comparableRows.length,
    verdict: comparableRows.length === 0 ? 'insufficient' : compared === comparableRows.length ? 'consistent' : 'mixed',
    suspects,
  }
}

export interface StabilityGroup {
  fingerprint: string
  configLabel: string
  runs: number
  /** Runs whose reading is trusted-success (terminal success + clean process). */
  trusted: number
  /** Every run of this configuration is trusted-success. */
  allPass: boolean
  /**
   * pass^k without replacement: C(trusted, k) / C(runs, k), with k = min(3, runs).
   * 1 means every draw of k runs would pass; 0 means at least one would not.
   */
  passK: number | null
  k: number
  /** Most common checkpoint walk, and its share of the group. */
  dominantPath: string
  dominantShare: number
  signatures: Array<{ signature: string; runs: number; share: number }>
}

export interface StabilityReport {
  taskId: string
  contractId: string
  contractVersion: string
  /** Live runs only — imported records are excluded (see module header). */
  runs: number
  groups: StabilityGroup[]
  /** Share of the most common walk across every live run of the task. */
  dominantPath: string
  dominantShare: number
  /** null when no configuration was run twice. */
  pooledPassK: number | null
}

function comb(n: number, k: number): number {
  if (k < 0 || k > n) return 0
  let r = 1
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1)
  return Math.round(r)
}

export function buildStability(
  readings: PilotRunReading[],
  contract: { contractId: string; version: string },
): StabilityReport {
  const live = readings.filter((r) => r.source === 'live')
  const byConfig = new Map<string, PilotRunReading[]>()
  for (const r of live) byConfig.set(r.fingerprint, [...(byConfig.get(r.fingerprint) ?? []), r])

  const groups: StabilityGroup[] = []
  for (const [fingerprint, runs] of byConfig) {
    if (runs.length < 2) continue
    const trusted = runs.filter((r) => r.bucket === 'trusted-success').length
    const k = Math.min(3, runs.length)
    const sigCount = new Map<string, number>()
    for (const r of runs) sigCount.set(r.pathSignature, (sigCount.get(r.pathSignature) ?? 0) + 1)
    const signatures = [...sigCount.entries()]
      .map(([signature, n]) => ({ signature, runs: n, share: Number((n / runs.length).toFixed(3)) }))
      .sort((a, b) => b.runs - a.runs || a.signature.localeCompare(b.signature))
    groups.push({
      fingerprint,
      configLabel: runs[0].configLabel,
      runs: runs.length,
      trusted,
      allPass: trusted === runs.length,
      passK: comb(trusted, k) / comb(runs.length, k),
      k,
      dominantPath: signatures[0].signature,
      dominantShare: signatures[0].share,
      signatures,
    })
  }
  groups.sort((a, b) => b.runs - a.runs || a.configLabel.localeCompare(b.configLabel))

  const sigCount = new Map<string, number>()
  for (const r of live) sigCount.set(r.pathSignature, (sigCount.get(r.pathSignature) ?? 0) + 1)
  const top = [...sigCount.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]

  // Pooled pass^k: average of the per-configuration estimates, weighted by runs.
  // Reporting an unweighted average would let a 2-run configuration outweigh a
  // 13-run one.
  const total = groups.reduce((n, g) => n + g.runs, 0)
  const pooledPassK = total > 0 ? groups.reduce((s, g) => s + (g.passK ?? 0) * g.runs, 0) / total : null

  return {
    taskId: live[0]?.taskId ?? '',
    contractId: contract.contractId,
    contractVersion: contract.version,
    runs: live.length,
    groups,
    dominantPath: top?.[0] ?? 'none',
    dominantShare: top ? Number((top[1] / live.length).toFixed(3)) : 0,
    pooledPassK,
  }
}
