// M4 paired gain statistics (PRISM §7.2④). Pure functions — no LLM, no IO.
//
// Evolution is judged on paired statistics (rescue / regress / net lift /
// bootstrap lower tail), not on a single demo run. The bootstrap resamples
// observed paired outcomes, so it adds no real runs (design §3.2).

export interface Pair {
  taskId: string
  baseline: boolean
  candidate: boolean
  candidateTokens?: number | null
  candidateLatencyMs?: number | null
  candidateCostUsd?: number | null
}

export interface PairedGain {
  rescued: string[]
  regressed: string[]
  stillFailed: string[]
  survived: string[]
  screened: number
  baselineRate: number
  candidateRate: number
  /** Candidate success-rate − baseline, in percentage points. */
  netLiftPp: number
  /** 5th-percentile bootstrap paired lift (pp). Null below the minimum sample. */
  relLift95: number | null
  avgTokens: number | null
  avgLatencyMs: number | null
  avgCostUsd: number | null
}

export const BOOTSTRAP_MIN_PAIRS = 3

/** Deterministic PRNG (mulberry32) so the bootstrap is reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Paired bootstrap lower bound on the success-rate difference (5th pct, pp). */
export function bootstrapLiftPp(pairs: Pair[], reps = 5000, seed = 20260920): number | null {
  const deltas = pairs.map((p) => Number(p.candidate) - Number(p.baseline))
  const n = deltas.length
  if (n < BOOTSTRAP_MIN_PAIRS) return null
  const rand = rng(seed)
  const means: number[] = []
  for (let r = 0; r < reps; r += 1) {
    let sum = 0
    for (let i = 0; i < n; i += 1) sum += deltas[Math.floor(rand() * n)]!
    means.push(sum / n)
  }
  means.sort((a, b) => a - b)
  const idx = Math.floor(means.length * 0.05)
  return Math.round(means[idx]! * 1000) / 10
}

function meanOrNull(vals: Array<number | null | undefined>): number | null {
  const xs = vals.filter((v): v is number => v != null && Number.isFinite(v))
  if (!xs.length) return null
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1_000_000) / 1_000_000
}

export function pairedGain(pairs: Pair[]): PairedGain {
  const rescued: string[] = []
  const regressed: string[] = []
  const stillFailed: string[] = []
  const survived: string[] = []
  for (const p of pairs) {
    if (!p.baseline && p.candidate) rescued.push(p.taskId)
    else if (p.baseline && !p.candidate) regressed.push(p.taskId)
    else if (!p.baseline && !p.candidate) stillFailed.push(p.taskId)
    else survived.push(p.taskId)
  }
  const n = pairs.length
  const baselineRate = n ? pairs.filter((p) => p.baseline).length / n : 0
  const candidateRate = n ? pairs.filter((p) => p.candidate).length / n : 0
  const tokens = pairs.map((p) => p.candidateTokens).filter((v): v is number => v != null)
  const lat = pairs.map((p) => p.candidateLatencyMs).filter((v): v is number => v != null)
  return {
    rescued,
    regressed,
    stillFailed,
    survived,
    screened: n,
    baselineRate,
    candidateRate,
    netLiftPp: Math.round((candidateRate - baselineRate) * 1000) / 10,
    relLift95: bootstrapLiftPp(pairs),
    avgTokens: tokens.length ? Math.round(tokens.reduce((a, b) => a + b, 0) / tokens.length) : null,
    avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
    avgCostUsd: meanOrNull(pairs.map((p) => p.candidateCostUsd)),
  }
}

/** Pareto frontier over (successRate, cost) — dominated candidates dropped. */
export interface CostPoint {
  id: string
  successRate: number
  cost: number
}

export function paretoFrontier(points: CostPoint[]): Set<string> {
  const frontier = new Set<string>()
  for (const p of points) {
    const dominated = points.some(
      (q) =>
        q.id !== p.id &&
        q.successRate >= p.successRate &&
        q.cost <= p.cost &&
        (q.successRate > p.successRate || q.cost < p.cost),
    )
    if (!dominated) frontier.add(p.id)
  }
  return frontier
}

/**
 * §7.2④ Pareto pick among gate-survivors: drop anyone with regressions, take
 * the frontier over (successRate ↑, cost ↓), then prefer highest success and
 * (ties) lowest cost. Returns null when no eligible candidate remains.
 */
export function pickParetoWinner(
  candidates: Array<{ id: string; successRate: number; cost: number; regressed: number }>,
): string | null {
  const ok = candidates.filter((c) => c.regressed === 0 && Number.isFinite(c.successRate) && Number.isFinite(c.cost))
  if (!ok.length) return null
  const front = paretoFrontier(ok.map((c) => ({ id: c.id, successRate: c.successRate, cost: c.cost })))
  const onFront = ok.filter((c) => front.has(c.id))
  onFront.sort((a, b) => {
    if (b.successRate !== a.successRate) return b.successRate - a.successRate
    return a.cost - b.cost
  })
  return onFront[0]?.id ?? null
}

// ── §7.2④ held-out gate pairing (pure summary) ─────────────────────────────

export interface GatePair {
  taskId: string
  baseline: boolean
  candidate: boolean
  candidateTokens?: number | null
  candidateLatencyMs?: number | null
  candidateCostUsd?: number | null
}

export interface GateStats {
  baselinePass: number
  candidatePass: number
  baselinePassPp: number
  candidatePassPp: number
  gateLiftPp: number
  regressed: string[]
  fixed: string[]
  avgTokens: number | null
  avgLatencyMs: number | null
  avgCostUsd: number | null
}

function pct(x: number, n: number): number {
  return n ? Math.round((x / n) * 1000) / 10 : 0
}

function uniq(ids: string[]): string[] {
  return [...new Set(ids)]
}

/** Pair-wise gate success/lift/regression over the held-out gate set (incl. repeats). */
export function gateStats(pairs: GatePair[]): GateStats {
  const n = pairs.length
  let bp = 0
  let cp = 0
  const regressed: string[] = []
  const fixed: string[] = []
  const tokens: number[] = []
  const lat: number[] = []
  for (const p of pairs) {
    if (p.baseline) bp += 1
    if (p.candidate) cp += 1
    if (p.baseline && !p.candidate) regressed.push(p.taskId)
    if (!p.baseline && p.candidate) fixed.push(p.taskId)
    if (p.candidateTokens != null) tokens.push(p.candidateTokens)
    if (p.candidateLatencyMs != null) lat.push(p.candidateLatencyMs)
  }
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null)
  return {
    baselinePass: bp,
    candidatePass: cp,
    baselinePassPp: pct(bp, n),
    candidatePassPp: pct(cp, n),
    gateLiftPp: Math.round((pct(cp, n) - pct(bp, n)) * 10) / 10,
    regressed: uniq(regressed),
    fixed: uniq(fixed),
    avgTokens: avg(tokens),
    avgLatencyMs: avg(lat),
    avgCostUsd: meanOrNull(pairs.map((p) => p.candidateCostUsd)),
  }
}
