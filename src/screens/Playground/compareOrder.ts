// Ordering for the trajectory-divergence pickers on the Live tab (`#/playground`,
// "Trajectory divergence"): the question picker and the two configuration pickers.
//
// All three dropdowns used to render in whatever order the run list arrived in —
// reverse chronological — so the question list jumped around unrelated questions
// (whatever ran last, first) and each configuration appeared as scattered
// duplicate entries in the A/B lists. The rule is now pinned here, the same way
// the run matrix pins its own:
//
//   questions      → General → Legal → Security, then the question number
//                   (natural, so S2 precedes S10)
//   configurations → one entry per harness configuration, label-sorted
//                   (natural, so C2 precedes C10). Re-running one configuration
//                   repeated its name in the list, so the pickers are deduped:
//                   each configuration appears once, carrying its newest run.
//
// Kept out of the .tsx so the order can be pinned by unit test without rendering.
import type { RunSummary } from '../../../shared/playground'
import { DOMAIN_RANK, questionNumber } from './resultOrder'

/** Natural string order: digit runs compare as numbers, so C2 precedes C10. */
export function naturalCompare(a: string, b: string): number {
  const as = a.match(/\d+|\D+/g) ?? []
  const bs = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i] ?? ''
    const y = bs[i] ?? ''
    if (x === y) continue
    const nx = /^\d/.test(x) ? Number(x) : null
    const ny = /^\d/.test(y) ? Number(y) : null
    if (nx != null && ny != null) return nx - ny
    // Same position, one numeric and one not: the numeric part leads.
    if (nx != null) return -1
    if (ny != null) return 1
    return x < y ? -1 : 1
  }
  return 0
}

export interface CompareTask {
  id: string
  title: string
  domain: RunSummary['domain']
  /**
   * One entry per configuration — the newest run of it — in the order the A/B
   * pickers must show.
   */
  runs: RunSummary[]
}

/**
 * One run per harness configuration — the newest — in arrival order.
 *
 * Identity is the fingerprint, not the name a particular run happens to carry:
 * the server resolves one name per configuration, so dropping repeated runs of
 * a configuration is also what removes the repeated name from the list. Re-runs
 * of one configuration used to appear as several identical entries, which is
 * both noise and a trap — A and B could land on two runs of the *same*
 * configuration and compare it with itself.
 */
export function dedupeRuns(runs: RunSummary[]): RunSummary[] {
  const newest = new Map<string, RunSummary>()
  for (const r of runs) {
    const cur = newest.get(r.fingerprint)
    if (!cur || r.createdAt > cur.createdAt || (r.createdAt === cur.createdAt && r.runId > cur.runId)) {
      newest.set(r.fingerprint, r)
    }
  }
  const kept = new Set(newest.values())
  return runs.filter((r) => kept.has(r))
}

/**
 * The entries the A/B pickers show for one question: one per configuration,
 * label-sorted so the picker reads in the same order as the run matrix's
 * columns.
 */
export function sortRuns(runs: RunSummary[]): RunSummary[] {
  return dedupeRuns(runs).sort(
    (a, b) => naturalCompare(a.configLabel, b.configLabel) || b.runId.localeCompare(a.runId),
  )
}

/**
 * The pair the A/B pickers fall back to: the two most recent *configurations* of
 * a question, in arrival order.
 *
 * Deliberately independent of {@link sortRuns} — sorting the pickers must not
 * change what is pre-selected, or the screen would silently start comparing a
 * different pair than before. Deduplication does reach this far, and has to:
 * a run that is no longer in the picker cannot be selected, so a pair built from
 * the full run list would leave one dropdown showing nothing.
 */
export function pickDefaultPair(runs: RunSummary[], taskId: string): [string, string] {
  const mine = dedupeRuns(runs.filter((r) => r.taskId === taskId))
  return [mine[0]?.runId ?? '', mine[1]?.runId ?? '']
}

/**
 * Questions that have at least two configurations — the only ones the A/B pickers
 * can compare — in General → Legal → Security order, then by question number.
 *
 * Two runs of ONE configuration are not a comparison, so they do not put a
 * question on the list.
 */
export function buildCompareTasks(runs: RunSummary[]): CompareTask[] {
  const byTask = new Map<string, RunSummary[]>()
  for (const r of runs) {
    const list = byTask.get(r.taskId)
    if (list) list.push(r)
    else byTask.set(r.taskId, [r])
  }
  const out: CompareTask[] = []
  for (const [id, list] of byTask) {
    const entries = sortRuns(list)
    if (entries.length < 2) continue
    const newest = list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
    out.push({ id, title: newest.taskTitle, domain: newest.domain, runs: entries })
  }
  out.sort((a, b) => {
    const byDomain = DOMAIN_RANK[a.domain] - DOMAIN_RANK[b.domain]
    if (byDomain !== 0) return byDomain
    const byNumber = questionNumber(a.id) - questionNumber(b.id)
    return byNumber !== 0 ? byNumber : a.id.localeCompare(b.id)
  })
  return out
}