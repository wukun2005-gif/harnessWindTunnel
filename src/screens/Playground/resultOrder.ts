// Ordering + grouping for the result matrix on the Run tab (`#/playground`).
//
// One row per question, one column per harness config. Kept out of the .tsx so
// the order can be pinned by unit test without rendering: the requirement is
// precise — General → Legal → Security, then the question number, with G2
// sorting before G10 — and it is exactly the kind of thing that breaks silently.
import type { PgDomain, RunSummary } from '../../../shared/playground'

/** GLS: the three domains in the order the result list must show them. */
export const DOMAIN_RANK: Record<PgDomain, number> = { general: 0, legal: 1, security: 2 }

/** G10 must sort after G2, so the numeric part drives the order, not the string. */
export function questionNumber(id: string): number {
  const m = /(\d+)/.exec(id)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * Which run the detail panel should show.
 *
 * - An existing selection is kept **as long as it is still in the list**, so
 *   narrowing the config filter drops a selection the list no longer contains.
 * - Otherwise: the newest run still in flight, falling back to the newest run.
 *
 * Replaces a `cur ?? …` that kept a selection *forever*: after starting a run
 * the list refreshed but the panel stayed on the previous run, which reads as
 * "the run I just launched returned that old result".
 */
export function pickActiveRun(runs: RunSummary[], cur: string | null): string | null {
  if (cur && runs.some((r) => r.runId === cur)) return cur
  // The list arrives newest-first, so runs[0] is the most recent activity. An
  // earlier version preferred any queued/running run — which pinned the panel to
  // a run that had died mid-flight and would never settle.
  return runs[0]?.runId ?? null
}

/**
 * Whether every run has finished scoring.
 *
 * The scorecard fetches full run details (answer, verdict, ROUGE, Jev reading) rather
 * than reading them off the list. A run that is still in flight has none of those yet,
 * so "fetched once" and "finished" are different things: stopping after the first
 * fetch left a column of dashes describing a run that had already completed by the
 * time anyone read it.
 */
export function allSettled(runs: RunSummary[]): boolean {
  return runs.every((r) => r.status === 'scored' || r.status === 'error')
}

export interface ResultRow {  taskId: string
  taskTitle: string
  domain: PgDomain
  /** config key (preset id, or 'custom') → newest run under it, plus how many exist. */
  cells: Map<string, { run: RunSummary; count: number }>
}

export function buildRows(runs: RunSummary[]): ResultRow[] {
  const byTask = new Map<string, RunSummary[]>()
  for (const r of runs) {
    const list = byTask.get(r.taskId)
    if (list) list.push(r)
    else byTask.set(r.taskId, [r])
  }
  const rows: ResultRow[] = []
  for (const [taskId, list] of byTask) {
    const cells = new Map<string, { run: RunSummary; count: number }>()
    for (const r of list) {
      const key = r.presetId ?? 'custom'
      const cur = cells.get(key)
      if (!cur) {
        cells.set(key, { run: r, count: 1 })
      } else {
        cur.count++
        // Newest occupies the cell; the count keeps re-runs from silently vanishing.
        if (r.createdAt > cur.run.createdAt) cur.run = r
      }
    }
    const newest = list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
    rows.push({ taskId, taskTitle: newest.taskTitle, domain: newest.domain, cells })
  }
  rows.sort((a, b) => {
    const byDomain = DOMAIN_RANK[a.domain] - DOMAIN_RANK[b.domain]
    if (byDomain !== 0) return byDomain
    const byNumber = questionNumber(a.taskId) - questionNumber(b.taskId)
    if (byNumber !== 0) return byNumber
    return a.taskId.localeCompare(b.taskId)
  })
  return rows
}
