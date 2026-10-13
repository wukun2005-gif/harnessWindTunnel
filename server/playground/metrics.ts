// M2 live metrics aggregation (design §11). Rules enforced here:
//  1. scored live runs only — queued/running/error and imported runs excluded
//  2. success = L2 scorer success, never run.finished.success
//  3. lift vs C0 is paired on task ids, and every shared task counts once
//  4. groups are keyed by config fingerprint; presetId is a display hint
import type { LiveMetricGroup, LiveMetrics, PgDomain, PgPresetId } from '../../shared/playground'
import { getPlaygroundDb, listRuns, listScoredLiveRuns, type ScoredRunRow } from './liveDb'
import { PG_PRESETS } from './presets'
import { makeConfigNamer } from './configNames'

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function pct(n: number): number {
  return Math.round(n * 1000) / 10
}

/**
 * Per-task success rate for one group: a task run five times contributes one
 * number, the average of its five runs.
 *
 * Collapsing repeats is the whole point. Two things go wrong if raw run rows
 * are paired directly. The candidate side gets weight proportional to how
 * often it happened to re-run a task, and the baseline side has to keep one
 * arbitrary row per taskId — whichever came last — so the reference is a coin
 * flip whenever a task's own runs disagree with each other.
 */
function taskSuccessRates(grp: ScoredRunRow[]): Map<string, number> {
  const hits = new Map<string, number>()
  const counts = new Map<string, number>()
  for (const r of grp) {
    counts.set(r.taskId, (counts.get(r.taskId) ?? 0) + 1)
    if (r.success) hits.set(r.taskId, (hits.get(r.taskId) ?? 0) + 1)
  }
  const rates = new Map<string, number>()
  for (const [taskId, n] of counts) rates.set(taskId, (hits.get(taskId) ?? 0) / n)
  return rates
}

/** Fewest shared tasks before a paired lift is worth printing at all. */
const MIN_PAIRED_TASKS = 2

export function computeLiveMetrics(): LiveMetrics {
  const rows = listScoredLiveRuns()
  // One name per configuration, resolved from the fingerprint — never read off
  // whichever run happens to sit at one end of the list.
  const nameConfig = makeConfigNamer(getPlaygroundDb())
  const totalRuns = listRuns({ limit: 500 }).length

  const byFingerprint = new Map<string, ScoredRunRow[]>()
  for (const r of rows) {
    const arr = byFingerprint.get(r.fingerprint) ?? []
    arr.push(r)
    byFingerprint.set(r.fingerprint, arr)
  }

  // C0 reference: the very group the table renders as the C0 row — the largest
  // fingerprint group holding C0-tagged runs, with all of that group's runs
  // counted. Selecting on the tag alone silently dropped untagged runs that
  // belong to the same configuration, which left the rate behind the lift
  // disagreeing with the rate printed in the C0 row.
  const c0Entry = [...byFingerprint.entries()]
    .filter(([, g]) => g.some((r) => r.presetId === 'C0'))
    .sort((a, b) => b[1].length - a[1].length)[0]
  const c0Fingerprint = c0Entry?.[0] ?? null
  const c0TaskRates = c0Entry ? taskSuccessRates(c0Entry[1]) : new Map<string, number>()

  const groups: LiveMetricGroup[] = []
  for (const [fingerprint, grp] of byFingerprint) {
    const presetId: PgPresetId | null = grp[0]?.presetId ?? null
    const named = nameConfig(fingerprint)
    const successRate = grp.filter((r) => r.success).length / grp.length
    const taskRates = taskSuccessRates(grp)
    const byDomain: LiveMetricGroup['byDomain'] = {}
    for (const dom of ['general', 'legal', 'security'] as PgDomain[]) {
      const dgrp = grp.filter((r) => r.domain === dom)
      if (dgrp.length === 0) continue
      byDomain[dom] = { runs: dgrp.length, successRate: pct(dgrp.filter((r) => r.success).length / dgrp.length) }
    }
    const tags: LiveMetricGroup['tags'] = {}
    for (const r of grp) for (const t of r.tags) tags[t] = (tags[t] ?? 0) + 1

    // Lift is measured against the C0 row's own configuration, not against
    // whichever presetId happens to sit on this group's first row — a
    // re-run of C0 carries no tag and must not be treated as a candidate.
    let lift: number | null = null
    let pairedTasks = 0
    if (c0Fingerprint !== null && fingerprint !== c0Fingerprint) {
      const shared = [...taskRates.keys()].filter((t) => c0TaskRates.has(t))
      pairedTasks = shared.length
      if (pairedTasks >= MIN_PAIRED_TASKS) {
        const delta = shared.reduce((sum, t) => sum + (taskRates.get(t)! - c0TaskRates.get(t)!), 0)
        lift = Math.round((delta / pairedTasks) * 1000) / 10
      }
    }

    groups.push({
      presetId,
      fingerprint,
      label: named.label,
      title: named.title,
      runs: grp.length,
      distinctTasks: taskRates.size,
      successRate: pct(successRate),
      avgTokens: avg(grp.map((r) => r.tokens).filter((x): x is number => x != null)),
      avgLatencyMs: avg(grp.map((r) => r.latencyMs).filter((x): x is number => x != null)),
      avgCostUsd: avg(grp.map((r) => r.costUsd).filter((x): x is number => x != null)),
      liftVsC0Pp: lift,
      liftPairedTasks: lift === null ? null : pairedTasks,
      byDomain,
      tags,
    })
  }

  // C0 first, then C1/C2/C3, then custom fingerprints by run count.
  const order = new Map(PG_PRESETS.map((p, i) => [p.id, i]))
  groups.sort((a, b) => {
    const oa = a.presetId ? (order.get(a.presetId) ?? 99) : 99
    const ob = b.presetId ? (order.get(b.presetId) ?? 99) : 99
    if (oa !== ob) return oa - ob
    return b.runs - a.runs
  })

  return { totalRuns, scoredRuns: rows.length, groups }
}