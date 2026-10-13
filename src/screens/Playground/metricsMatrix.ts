// Pure, deterministic matrix builders for the live metrics area (design §10 M3).
// Inputs are RunSummary rows already filtered by the source toggle; outputs are
// ready for table / SVG rendering. No LLM, no fixture data.
import type { RunSummary } from '../../../shared/playground'
import { MAST_LABEL, type MastTag } from '../../../shared/mast'

/** The 12 first-class failure tags + other, in canonical order. */
export const MAST_TAGS: MastTag[] = Object.keys(MAST_LABEL) as MastTag[]

/** A column in the cross matrices: one harness configuration. */
export interface ConfigCol {
  key: string // fingerprint (stable identity)
  /** Display name of the configuration — the same one every other view uses. */
  label: string
  title: string | null
}

/**
 * Column order, so every table on the screen lines up: the four presets in
 * their design order first, then anything else (an evolved configuration)
 * alphabetically. Without this, one table ordered columns by which run it saw
 * first and the other by preset order, so the same five configurations
 * appeared in two different sequences.
 */
const PRESET_RANK = new Map(['C0', 'C1', 'C2', 'C3'].map((id, i) => [id, i]))

/** Group runs by fingerprint and build the column list in a stable order. */
export function configCols(runs: RunSummary[]): ConfigCol[] {
  const cols = new Map<string, ConfigCol>()
  for (const r of runs) {
    if (!cols.has(r.fingerprint)) {
      cols.set(r.fingerprint, {
        key: r.fingerprint,
        label: r.configLabel,
        title: r.configTitle,
      })
    }
  }
  return [...cols.values()].sort((a, b) => {
    const ra = PRESET_RANK.get(a.label) ?? 99
    const rb = PRESET_RANK.get(b.label) ?? 99
    return ra !== rb ? ra - rb : a.label.localeCompare(b.label)
  })
}

export interface FailureCell {
  count: number
  total: number // runs in that column
}

/** Failure mode × config distribution: rows = 12 tags, cols = configs. */
export function failureByConfig(runs: RunSummary[]): {
  cols: ConfigCol[]
  tags: string[]
  cells: Record<string, Record<string, FailureCell>>
} {
  const cols = configCols(runs)
  const totals = new Map<string, number>()
  const counts = new Map<string, Map<string, number>>()
  for (const r of runs) {
    totals.set(r.fingerprint, (totals.get(r.fingerprint) ?? 0) + 1)
    for (const tag of r.failureTags) {
      let m = counts.get(tag)
      if (!m) {
        m = new Map<string, number>()
        counts.set(tag, m)
      }
      m.set(r.fingerprint, (m.get(r.fingerprint) ?? 0) + 1)
    }
  }
  const cells: Record<string, Record<string, FailureCell>> = {}
  const tagsPresent = [...counts.keys()].sort((a, b) => {
    const ia = MAST_TAGS.indexOf(a as MastTag)
    const ib = MAST_TAGS.indexOf(b as MastTag)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
  for (const tag of tagsPresent) {
    cells[tag] = {}
    for (const c of cols) {
      cells[tag]![c.key] = {
        count: counts.get(tag)?.get(c.key) ?? 0,
        total: totals.get(c.key) ?? 0,
      }
    }
  }
  return { cols, tags: tagsPresent, cells }
}

export interface ParetoPoint {
  label: string
  n: number
  successRate: number
  avgTokens: number
  avgLatency: number
  /**
   * L3 mean USD cost from the provider×model price table. Null when the runs'
   * model is not in the table — never fabricated (design §11.2).
   */
  avgCostUsd: number | null
}

/**
 * Quality-cost Pareto: one point per config. x = cost, y = success rate.
 *
 * The x axis is real USD as soon as any run in view has a priced model; only
 * then does it fall back to the token proxy and say so on the axis label.
 */
export function paretoPoints(runs: RunSummary[]): ParetoPoint[] {
  const cols = configCols(runs)
  const points: ParetoPoint[] = []
  for (const c of cols) {
    const inCol = runs.filter((r) => r.fingerprint === c.key)
    const scored = inCol.filter((r) => r.success !== null)
    if (scored.length === 0) continue
    const pass = scored.filter((r) => r.success).length
    const tok = inCol.filter((r) => r.tokens != null)
    const lat = inCol.filter((r) => r.latencyMs != null)
    const priced = inCol.filter((r) => r.costUsd != null)
    points.push({
      label: c.label,
      n: scored.length,
      successRate: pass / scored.length,
      avgTokens: tok.length ? tok.reduce((s, r) => s + (r.tokens ?? 0), 0) / tok.length : 0,
      avgLatency: lat.length ? lat.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / lat.length : 0,
      avgCostUsd: priced.length
        ? priced.reduce((s, r) => s + (r.costUsd ?? 0), 0) / priced.length
        : null,
    })
  }
  return points
}

/** Which cost axis the chart can honestly draw: USD, or the token proxy. */
export function paretoAxis(points: ParetoPoint[]): 'usd' | 'token' {
  return points.some((p) => p.avgCostUsd != null) ? 'usd' : 'token'
}

/** Cost of a point on the given axis; unpriced points sit at 0 on the USD axis. */
export function paretoCost(p: ParetoPoint, axis: 'usd' | 'token'): number {
  return axis === 'usd' ? p.avgCostUsd ?? 0 : p.avgTokens
}

/** Marks Pareto-frontier points (success not dominated by a cheaper point). */
export function paretoFrontier(points: ParetoPoint[]): Set<string> {
  const front = new Set<string>()
  let best = -1
  for (const p of points) {
    if (p.successRate > best) {
      front.add(p.label)
      best = p.successRate
    }
  }
  return front
}

export interface CrossCell {
  n: number
  rate: number | null
}

/** Model × harness cross matrix: rows = models, cols = configs, cell = success rate. */
export function modelByHarness(runs: RunSummary[]): {
  models: string[]
  cols: ConfigCol[]
  cells: Record<string, Record<string, CrossCell>>
} {
  const cols = configCols(runs)
  const models = [...new Set(runs.map((r) => r.model))].sort()
  const cells: Record<string, Record<string, CrossCell>> = {}
  for (const m of models) {
    cells[m] = {}
    for (const c of cols) {
      const set = runs.filter((r) => r.model === m && r.fingerprint === c.key)
      const scored = set.filter((r) => r.success !== null)
      cells[m]![c.key] = {
        n: scored.length,
        rate: scored.length ? scored.filter((r) => r.success).length / scored.length : null,
      }
    }
  }
  return { models, cols, cells }
}
