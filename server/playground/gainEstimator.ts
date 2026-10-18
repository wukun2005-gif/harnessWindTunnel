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
  /**
   * Set when a DETERMINISTIC check (leak / injection / statute existence)
   * flipped from clean on the parent to failing on the candidate. It is read
   * off the detector, not off the judge's reading, so it is not subject to the
   * reading's noise.
   */
  hardFlip?: string | null
  /** Baseline deterministic checks were clean in this pair. */
  baselineClean?: boolean
  /** Candidate deterministic checks were clean in this pair. */
  candidateClean?: boolean
}

/** A deterministic check the parent passed and the candidate failed. */
export interface HardRegression {
  taskId: string
  reason: string
}

export interface PairedClass {
  rescued: string[]
  regressed: string[]
  stillFailed: string[]
  survived: string[]
  /** Tasks whose flip did not reproduce on every pair — no signal, not counted. */
  unstable: string[]
  hardRegressions: HardRegression[]
}

/**
 * Classify paired runs into rescued / regressed / unchanged.
 *
 * One pair is a single sample, and a single sample is not evidence here. Two
 * measurements on this eval set say so: across 1486 same-config run pairs on the
 * same task the score moves by 0.28 or more in 30% of them, and G1 — a task that
 * passes 25% of the time — passed the baseline half of one screen by luck and
 * then produced a "regression" that was nothing but that coin flip.
 *
 * So a flip counts only when it reproduces on EVERY pair the slot was given.
 * Every other disagreement is `unstable`: recorded, shown, and counted as
 * neither a rescue nor a regression. The rule is applied in both directions, so
 * it cannot be gamed into passing.
 *
 * A deterministic check that flipped is a regression regardless of the reading:
 * the reading can call both halves "failed" while the parent's answer was clean
 * and the candidate's leaked a citizen ID number — that is exactly how a real
 * safety regression stayed invisible.
 */
export function classifyPaired(pairs: Pair[]): PairedClass {
  const byTask = new Map<string, Pair[]>()
  for (const p of pairs) {
    const list = byTask.get(p.taskId)
    if (list) list.push(p)
    else byTask.set(p.taskId, [p])
  }
  const rescued: string[] = []
  const regressed: string[] = []
  const stillFailed: string[] = []
  const survived: string[] = []
  const unstable: string[] = []
  const hardRegressions: HardRegression[] = []
  for (const [taskId, list] of byTask) {
    const flipsUp = list.filter((p) => !p.baseline && p.candidate).length
    const flipsDown = list.filter((p) => p.baseline && !p.candidate).length
    // A deterministic check that was clean on every baseline half and broken on
    // every candidate half. Requiring every pair keeps the same noise rule.
    const hardDown = list.filter((p) => p.baselineClean === true && p.candidateClean === false)
    const hardClean = list.filter((p) => p.baselineClean === true)
    if (hardDown.length > 0 && hardDown.length === hardClean.length) {
      regressed.push(taskId)
      hardRegressions.push({ taskId, reason: hardDown[0]!.hardFlip ?? 'deterministic check regressed' })
      continue
    }
    if (flipsDown > 0 && flipsDown === list.length) {
      regressed.push(taskId)
      continue
    }
    if (flipsUp > 0 && flipsUp === list.length) {
      rescued.push(taskId)
      continue
    }
    if (flipsDown > 0 || flipsUp > 0) {
      unstable.push(taskId)
      continue
    }
    if (list.every((p) => p.baseline && p.candidate)) survived.push(taskId)
    else stillFailed.push(taskId)
  }
  return { rescued, regressed, stillFailed, survived, unstable, hardRegressions }
}

export interface PairedGain {
  rescued: string[]
  regressed: string[]
  stillFailed: string[]
  survived: string[]
  /** Tasks whose flip failed to reproduce — recorded, counted as neither. */
  unstable: string[]
  /** Deterministic-check regressions (same noise rule as `regressed`). */
  hardRegressions: HardRegression[]
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
  const cls = classifyPaired(pairs)
  const { rescued, regressed, stillFailed, survived, unstable, hardRegressions } = cls
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
    unstable,
    hardRegressions,
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
  /** See Pair.hardFlip / baselineClean / candidateClean. */
  hardFlip?: string | null
  baselineClean?: boolean
  candidateClean?: boolean
}

export interface GateStats {
  baselinePass: number
  candidatePass: number
  baselinePassPp: number
  candidatePassPp: number
  gateLiftPp: number
  regressed: string[]
  fixed: string[]
  /** Tasks whose flip did not reproduce across repeats — no signal. */
  unstable: string[]
  /** Deterministic-check regressions inside the gate. */
  hardRegressions: HardRegression[]
  avgTokens: number | null
  avgLatencyMs: number | null
  avgCostUsd: number | null
}

function pct(x: number, n: number): number {
  return n ? Math.round((x / n) * 1000) / 10 : 0
}

/**
 * Pair-wise gate success/lift/regression over the held-out gate set (incl.
 * repeats).
 *
 * Regressions and fixes go through the same noise rule as the screen
 * (`classifyPaired`): a task must flip on every repeat it was given, so a
 * single flipped sample at ×2 cannot roll back a generation. The pass counts
 * and the lift still use every answered pair — the rule only decides which
 * tasks get NAMED, never how much moved.
 */
export function gateStats(pairs: GatePair[]): GateStats {
  const n = pairs.length
  let bp = 0
  let cp = 0
  const tokens: number[] = []
  const lat: number[] = []
  for (const p of pairs) {
    if (p.baseline) bp += 1
    if (p.candidate) cp += 1
    if (p.candidateTokens != null) tokens.push(p.candidateTokens)
    if (p.candidateLatencyMs != null) lat.push(p.candidateLatencyMs)
  }
  const cls = classifyPaired(pairs)
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null)
  return {
    baselinePass: bp,
    candidatePass: cp,
    baselinePassPp: pct(bp, n),
    candidatePassPp: pct(cp, n),
    gateLiftPp: Math.round((pct(cp, n) - pct(bp, n)) * 10) / 10,
    regressed: cls.regressed,
    fixed: cls.rescued,
    unstable: cls.unstable,
    hardRegressions: cls.hardRegressions,
    avgTokens: avg(tokens),
    avgLatencyMs: avg(lat),
    avgCostUsd: meanOrNull(pairs.map((p) => p.candidateCostUsd)),
  }
}
