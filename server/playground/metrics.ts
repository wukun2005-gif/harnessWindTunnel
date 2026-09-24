// M2 live metrics aggregation (design §11). Rules enforced here:
//  1. scored live runs only — queued/running/error and imported runs excluded
//  2. success = L2 scorer success, never run.finished.success
//  3. lift vs C0 is computed on the intersection of task ids (paired comparison)
//  4. groups are keyed by config fingerprint; presetId is a display hint
import type { LiveMetricGroup, LiveMetrics, PgDomain, PgPresetId } from '../../shared/playground'
import { listRuns, listScoredLiveRuns, type ScoredRunRow } from './liveDb'
import { PG_PRESETS } from './presets'

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

function pct(n: number): number {
  return Math.round(n * 1000) / 10
}

export function computeLiveMetrics(): LiveMetrics {
  const rows = listScoredLiveRuns()
  const totalRuns = listRuns({ limit: 500 }).length

  const byFingerprint = new Map<string, ScoredRunRow[]>()
  for (const r of rows) {
    const arr = byFingerprint.get(r.fingerprint) ?? []
    arr.push(r)
    byFingerprint.set(r.fingerprint, arr)
  }

  // C0 reference: the group whose preset is C0; fall back to the preset's
  // fingerprint when no C0 live run exists yet.
  const c0 = rows.filter((r) => r.presetId === 'C0')
  const c0Tasks = new Map<string, boolean>()
  for (const r of c0) c0Tasks.set(r.taskId, r.success)
  const c0Rate = c0.length ? c0.filter((r) => r.success).length / c0.length : null

  const groups: LiveMetricGroup[] = []
  for (const [fingerprint, grp] of byFingerprint) {
    const presetId: PgPresetId | null = grp[0]?.presetId ?? null
    const successRate = grp.filter((r) => r.success).length / grp.length
    const byDomain: LiveMetricGroup['byDomain'] = {}
    for (const dom of ['general', 'legal', 'security'] as PgDomain[]) {
      const dgrp = grp.filter((r) => r.domain === dom)
      if (dgrp.length === 0) continue
      byDomain[dom] = { runs: dgrp.length, successRate: pct(dgrp.filter((r) => r.success).length / dgrp.length) }
    }
    const tags: LiveMetricGroup['tags'] = {}
    for (const r of grp) for (const t of r.tags) tags[t] = (tags[t] ?? 0) + 1

    let lift: number | null = null
    if (presetId !== 'C0' && c0Rate !== null) {
      // Paired on the task-id intersection; require at least 2 shared tasks.
      const shared = grp.filter((r) => c0Tasks.has(r.taskId))
      if (shared.length >= 2) {
        const gRate = shared.filter((r) => r.success).length / shared.length
        const cRate = shared.reduce((n, r) => n + (c0Tasks.get(r.taskId) ? 1 : 0), 0) / shared.length
        lift = Math.round((gRate - cRate) * 1000) / 10
      }
    }

    groups.push({
      presetId,
      fingerprint,
      runs: grp.length,
      successRate: pct(successRate),
      avgTokens: avg(grp.map((r) => r.tokens).filter((x): x is number => x != null)),
      avgLatencyMs: avg(grp.map((r) => r.latencyMs).filter((x): x is number => x != null)),
      liftVsC0Pp: lift,
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
