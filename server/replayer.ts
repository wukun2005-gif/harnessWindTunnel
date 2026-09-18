import { readFileSync, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { configDistance, fingerprint, type HarnessConfig } from '../shared/config'
import type { BranchMeta, HarnessEvent, MetricsEntry, ReplayMeta, ScenarioMeta, SourceRef } from '../shared/events'

const DATA = resolve(process.cwd(), 'data')
const cache = new Map<string, { data: unknown; mtime: number }>()

function readJson<T>(p: string): T {
  const { mtimeMs } = statSync(p)
  const cached = cache.get(p)
  if (cached && cached.mtime === mtimeMs) return cached.data as T
  const data = JSON.parse(readFileSync(p, 'utf8'))
  cache.set(p, { data, mtime: mtimeMs })
  return data as T
}

export function listScenarios(): { scenarioId: string }[] {
  return readJson(resolve(DATA, 'scenarios', 'index.json'))
}

export function getScenario(scenarioId: string): ScenarioMeta {
  return readJson(resolve(DATA, 'scenarios', scenarioId, 'meta.json'))
}

export function nearestBranch(scenario: ScenarioMeta, config: HarnessConfig): { branch: BranchMeta; distance: number; exact: boolean } {
  const fp = fingerprint(config)
  const exact = scenario.branches.find((b) => b.fingerprint === fp)
  if (exact) return { branch: exact, distance: 0, exact: true }
  let best = scenario.branches[0]
  let bestD = Number.POSITIVE_INFINITY
  for (const b of scenario.branches) {
    const d = configDistance(b.config, config)
    if (d < bestD) { bestD = d; best = b }
  }
  return { branch: best, distance: bestD, exact: false }
}

export function loadEvents(scenarioId: string, branchId: string): HarnessEvent[] {
  const scenario = getScenario(scenarioId)
  const b = scenario.branches.find((x) => x.branchId === branchId)
  if (!b) throw new Error(`branch not found: ${branchId}`)
  if (!b.file) throw new Error(`branch ${branchId} is metrics-only (no pre-recorded trajectory)`)
  const p = resolve(DATA, 'scenarios', scenarioId, 'branches', b.file)
  return readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) as HarnessEvent[]
}

export function resolveReplay(scenarioId: string, config?: HarnessConfig, branchId?: string): { meta: ReplayMeta; events: HarnessEvent[] } {
  const scenario = getScenario(scenarioId)
  if (branchId) {
    const b = scenario.branches.find((x) => x.branchId === branchId)
    if (!b) throw new Error(`branch not found: ${branchId}`)
    return {
      meta: {
        runId: `${scenarioId}#${branchId}`, scenarioId, branchId, configFingerprint: b.fingerprint,
        exactMatch: true,
        source: { kind: 'fixture', label: 'Offline fixture · deterministic replay' },
      },
      events: loadEvents(scenarioId, branchId),
    }
  }
  if (!config) throw new Error('config or branchId required')
  const { branch, distance, exact } = nearestBranch(scenario, config)
  const source: SourceRef = exact
    ? { kind: 'fixture', label: 'Offline fixture · deterministic replay' }
    : { kind: 'fixture', label: `Approximate · nearest-neighbor branch (differs by ${distance} fields)` }
  return {
    meta: {
      runId: `${scenarioId}#${branch.branchId}`, scenarioId, branchId: branch.branchId, configFingerprint: branch.fingerprint,
      exactMatch: exact, nearestTo: exact ? undefined : { branchId: branch.branchId, distance },
      source,
    },
    events: loadEvents(scenarioId, branch.branchId),
  }
}

export function getMetrics(scenarioId: string): Record<string, MetricsEntry> {
  return getScenario(scenarioId).metrics
}

export function metricsForConfig(scenarioId: string, config: HarnessConfig): { entry: MetricsEntry; exact: boolean; nearestFp?: string; distance?: number } {
  const metrics = getMetrics(scenarioId)
  const fp = fingerprint(config)
  if (metrics[fp]) return { entry: metrics[fp], exact: true }
  const scenario = getScenario(scenarioId)
  let bestFp = ''
  let bestD = Number.POSITIVE_INFINITY
  for (const key of Object.keys(metrics)) {
    const bc = scenario.branches.find((b) => b.fingerprint === key)?.config
    if (!bc) continue
    const d = configDistance(bc, config)
    if (d < bestD) { bestD = d; bestFp = key }
  }
  // A metric-matrix key may have no matching branch (metrics-only branch); fall back to an approximate combination
  const entry = metrics[bestFp] ?? Object.values(metrics)[0]
  return { entry, exact: false, nearestFp: bestFp || undefined, distance: bestD === Number.POSITIVE_INFINITY ? undefined : bestD }
}

export function hasData(): boolean {
  return existsSync(resolve(DATA, 'scenarios', 'index.json'))
}
