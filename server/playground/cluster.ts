// M4 deterministic failure clustering (PRISM §7.2①).
//
// Closed-system grouping: failure tag (12+1) × actionable seam (the closed
// routing table) for repair-split failed runs. The LLM never participates in
// the grouping — it may only rewrite the one-line summary for display.
import type { HarnessEvent } from '../../shared/events'
import type {
  EvoCluster,
  EvoSurface,
  PgDomain,
  RunDetail,
} from '../../shared/playground'
import { ROUTE_TABLE, routeCluster } from './router'
import { appliedSurfacesForCluster } from './evoDb'
import { MAST_LABEL } from '../../shared/mast'

/** Earliest failure.tag step on a run that never recovered (server-side twin of deriveRun). */
export function criticalStepOf(events: HarnessEvent[], success: boolean | null): number | null {
  if (success === true) return null
  const tagSteps = events
    .filter((e): e is Extract<HarnessEvent, { type: 'failure.tag' }> => e.type === 'failure.tag')
    .map((e) => e.step)
    .sort((a, b) => a - b)
  return tagSteps.length ? tagSteps[0]! : null
}

/** Primary failure tag = the tag on the earliest failure.tag event. */
export function primaryTagOf(events: HarnessEvent[], fallback: string[]): string {
  const first = events
    .filter((e): e is Extract<HarnessEvent, { type: 'failure.tag' }> => e.type === 'failure.tag')
    .sort((a, b) => a.step - b.step)[0]
  if (first) return first.mast
  return fallback[0] ?? 'other'
}

interface GroupAcc {
  tag: string
  seam: string
  runs: RunDetail[]
  criticalSteps: number[]
}

const CLUSTER_TAG = {
  summary: (tag: string, seam: string, count: number, domain: string) =>
    `${count} failed repair run(s) hit "${MAST_LABEL[tag as keyof typeof MAST_LABEL] ?? tag}"; ` +
    `attributable seam: ${seam}${domain !== 'mixed' ? ` (${domain} domain)` : ' (cross-domain)'}.`,
}

/**
 * Cluster failed repair runs deterministically. Returns persisted-ready
 * clusters with their initial routing decision (surface + dynamic upgrade).
 */
export function clusterRuns(runs: RunDetail[], now: string = new Date().toISOString()): EvoCluster[] {
  const groups = new Map<string, GroupAcc>()

  for (const run of runs) {
    if (run.split !== 'repair') continue
    if (run.success !== false) continue
    const tag = primaryTagOf(run.events, run.failureTags) as EvoCluster['tag']
    const rule = ROUTE_TABLE[tag]
    const seam = rule ? rule.seam : 'human review (no auto routing)'
    const key = `${tag}::${rule ? rule.seamControl : 'human'}`
    if (!groups.has(key)) groups.set(key, { tag, seam, runs: [], criticalSteps: [] })
    const g = groups.get(key)!
    g.runs.push(run)
    const cs = criticalStepOf(run.events, run.success)
    if (cs != null) g.criticalSteps.push(cs)
  }

  const clusters: EvoCluster[] = []
  let idx = 0
  for (const [key, g] of groups) {
    idx += 1
    const domains = new Set(g.runs.map((r) => r.domain))
    const domain: PgDomain | 'mixed' = domains.size === 1 ? ([...domains][0] as PgDomain) : 'mixed'
    const criticalSteps = [...g.criticalSteps].sort((a, b) => a - b)
    // Cluster id is stable across re-analysis for the same tag+seam+run set.
    const runIdSig = g.runs.map((r) => r.runId).sort().join(',')
    const clusterId = `cl_${g.tag}_${hash(key + runIdSig).slice(0, 10)}`

    // Dynamic upgrade: read prior applied surfaces (empty for a fresh cluster).
    const prior = appliedSurfacesForCluster(clusterId)
    const route = routeCluster(g.tag as EvoCluster['tag'], prior)
    const initialSurface: EvoSurface | 'human' = route.surface

    clusters.push({
      clusterId,
      createdAt: now,
      tag: g.tag as EvoCluster['tag'],
      seam: g.seam,
      key,
      count: g.runs.length,
      domain,
      criticalSteps,
      summary: CLUSTER_TAG.summary(g.tag, g.seam, g.runs.length, domain),
      runIds: g.runs.map((r) => r.runId),
      taskIds: [...new Set(g.runs.map((r) => r.taskId))].sort(),
      routeHistory: [
        {
          surface: initialSurface === 'human' ? 'middleware' : initialSurface,
          reason: route.reason,
          at: now,
        },
      ],
      status: 'open',
    })
  }

  // Largest clusters first.
  return clusters.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i += 1) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return Math.abs(h).toString(36)
}
