// PRD §6 reliability & adaptation statistics (F2-6, F2-11).
// All functions are pure and deterministic: bootstrap uses a seeded PRNG, so
// every reading is recalculable from fixture data with no extra model calls.

export interface LiftStats {
  n: number
  meanLift: number
  maxLift: number
  worstLift: number
  /** Share of runs with Lift > 0. */
  rr0: number
  /** 5th percentile of the bootstrapped mean-Lift distribution. */
  relLift95: number
}

export function mean(xs: number[]): number {
  if (xs.length === 0) return NaN
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Sample standard deviation (n-1); 0 for fewer than 2 values. */
export function std(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1))
}

/** Deterministic PRNG (mulberry32). Same seed → same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a string hash → uint32 seed. */
export function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Element-wise paired lifts. Null when inputs are unusable (empty or mismatched). */
export function pairedLifts(candRuns: number[], baseRuns: number[]): number[] | null {
  if (candRuns.length === 0 || candRuns.length !== baseRuns.length) return null
  if (![...candRuns, ...baseRuns].every((v) => Number.isFinite(v))) return null
  return candRuns.map((v, i) => v - baseRuns[i])
}

/**
 * 5th percentile of the bootstrapped mean distribution: resample `draws` times
 * with replacement, average each draw, take the 5th percentile.
 */
export function bootstrapP5(xs: number[], draws: number, seed: number): number {
  if (xs.length === 0) return NaN
  if (xs.length === 1) return xs[0]
  const rand = mulberry32(seed)
  const n = xs.length
  const means = new Array<number>(draws)
  for (let d = 0; d < draws; d++) {
    let s = 0
    for (let i = 0; i < n; i++) s += xs[Math.floor(rand() * n)]
    means[d] = s / n
  }
  means.sort((a, b) => a - b)
  return means[Math.max(0, Math.floor(0.05 * draws))]
}

export const BOOTSTRAP_DRAWS = 5000

/** Full lower-tail stat block for one candidate vs the locked baseline. */
export function liftStats(lifts: number[] | null, seed: number): LiftStats | null {
  if (!lifts || lifts.length === 0) return null
  return {
    n: lifts.length,
    meanLift: mean(lifts),
    maxLift: Math.max(...lifts),
    worstLift: Math.min(...lifts),
    rr0: lifts.filter((v) => v > 0).length / lifts.length,
    relLift95: bootstrapP5(lifts, BOOTSTRAP_DRAWS, seed),
  }
}

/**
 * Fragile-configuration warning (PRD F2-6 AC): mean looks good but the lower
 * tail is negative or the win rate is low (Airbnb τ²-Telecom: RR₀ 25–75%).
 */
export function isFragile(s: LiftStats): boolean {
  return s.meanLift > 0 && (s.worstLift < 0 || s.rr0 < 0.75)
}

// ---------- F2-11 adaptation profile ----------

export type FitRating = 'Recommended' | 'Compatible' | 'Caution'

export interface Spread {
  range: number
  std: number
}

/** Cross-model score dispersion for one locked harness. */
export function compatibilitySpread(scores: number[]): Spread | null {
  if (scores.length === 0) return null
  return { range: Math.max(...scores) - Math.min(...scores), std: std(scores) }
}

/**
 * Three-tier fit rating (PRD §6): all-positive conditional lifts with
 * non-negative cross-model worst → Recommended; positive mean but wide
 * spread → Compatible; any negative → Caution (names the model in the UI).
 */
export function fitRating(conditionalLifts: number[]): FitRating | null {
  if (conditionalLifts.length === 0) return null
  if (conditionalLifts.every((v) => v > 0) && Math.min(...conditionalLifts) >= 0) return 'Recommended'
  if (mean(conditionalLifts) > 0) return 'Compatible'
  return 'Caution'
}

/** Kendall tau rank correlation in [-1, 1]; null when undefined. */
export function kendallTau(a: number[], b: number[]): number | null {
  if (a.length !== b.length || a.length < 2) return null
  let conc = 0
  let disc = 0
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const s = Math.sign(a[i] - a[j]) * Math.sign(b[i] - b[j])
      if (s > 0) conc++
      else if (s < 0) disc++
    }
  }
  const denom = conc + disc
  return denom === 0 ? null : (conc - disc) / denom
}
