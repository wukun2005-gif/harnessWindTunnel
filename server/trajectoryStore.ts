// F7 D7 — trajectory store: loads 16 fixture contracts + 28 fixture traces and,
// for P2, 45 live task contracts evaluated against persisted live runs.
// Deterministic pure functions + cache by (runId, contractVersion, stream length).
// Read-only: no write endpoints, no network, no clock — same input ⇒
// byte-identical output across requests (F7-8 可复算).
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  parseEvents,
  trajectoryContract,
  type TrajectoryContract,
  type TrajectorySource,
  type TrajectoryVerdictDetail,
  type TrajectoryVerdictResponse,
} from '../shared/trajectory'
import { evaluateEvents } from '../shared/trajectoryEval'
import { buildConsistency, buildStability, type ConsistencyReport, type PilotRunReading, type PilotTaskSummary, type StabilityReport } from '../shared/trajectoryStats'
import type { ScenarioMeta } from '../shared/events'
import { getRunDetail, listRuns } from './playground/liveDb'

const DATA = resolve(process.cwd(), 'data')

interface RunBinding {
  runId: string
  file: string
  contractId: string
  source: TrajectorySource
}

let contracts: TrajectoryContract[] | null = null
let liveContracts: TrajectoryContract[] | null = null
let bindings: RunBinding[] | null = null
const cache = new Map<string, TrajectoryVerdictDetail>()

export function loadContracts(): TrajectoryContract[] {
  if (contracts) return contracts
  const dir = resolve(DATA, 'trajectory', 'contracts')
  const list: TrajectoryContract[] = []
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      list.push(trajectoryContract.parse(JSON.parse(readFileSync(resolve(dir, f), 'utf8'))))
    }
  }
  contracts = list
  return list
}

export function getContract(contractId: string): TrajectoryContract | undefined {
  return loadContracts().find((c) => c.contractId === contractId)
}

/**
 * P2 live contracts (one per task, never per run). Kept in a separate
 * directory so the fixture corpus and its coverage counts stay untouched.
 */
export function loadLiveContracts(): TrajectoryContract[] {
  if (liveContracts) return liveContracts
  const dir = resolve(DATA, 'trajectory', 'live-contracts')
  const list: TrajectoryContract[] = []
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
      list.push(trajectoryContract.parse(JSON.parse(readFileSync(resolve(dir, f), 'utf8'))))
    }
  }
  liveContracts = list
  return list
}

export function getLiveContractForTask(taskId: string): TrajectoryContract | undefined {
  return loadLiveContracts().find((c) => c.target.kind === 'task' && c.target.id === taskId)
}

function contractForTarget(kind: string, id: string): TrajectoryContract | undefined {
  return loadContracts().find((c) => c.target.kind === kind && c.target.id === id)
}

/** Scenario branches (17 runs) + legal traces (5) + red-team traces (6) = 28. */
export function loadRunBindings(): RunBinding[] {
  if (bindings) return bindings
  const list: RunBinding[] = []
  const index = existsSync(resolve(DATA, 'scenarios', 'index.json'))
    ? (JSON.parse(readFileSync(resolve(DATA, 'scenarios', 'index.json'), 'utf8')) as { scenarioId: string }[])
    : []
  for (const { scenarioId } of index) {
    const metaPath = resolve(DATA, 'scenarios', scenarioId, 'meta.json')
    if (!existsSync(metaPath)) continue
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ScenarioMeta
    if (!contractForTarget('scenario', scenarioId)) continue
    for (const b of meta.branches) {
      if (!b.file) continue
      list.push({ runId: `${scenarioId}#${b.branchId}`, file: resolve(DATA, 'scenarios', scenarioId, 'branches', b.file), contractId: contractForTarget('scenario', scenarioId)!.contractId, source: 'fixture' })
    }
  }
  const domains: Array<{ dir: string; kind: 'dossier' | 'attack'; prefix: string; source: TrajectorySource }> = [
    { dir: resolve(DATA, 'domain', 'legal', 'traces'), kind: 'dossier', prefix: 'legal', source: 'fixture' },
    { dir: resolve(DATA, 'redteam', 'traces'), kind: 'attack', prefix: 'redteam', source: 'fixture' },
  ]
  for (const d of domains) {
    if (!existsSync(d.dir)) continue
    for (const f of readdirSync(d.dir).filter((x) => x.endsWith('.jsonl')).sort()) {
      const id = f.replace(/\.jsonl$/, '')
      const c = contractForTarget(d.kind, id)
      if (!c) continue
      list.push({ runId: `${d.prefix}#${id}`, file: resolve(d.dir, f), contractId: c.contractId, source: d.source })
    }
  }
  bindings = list
  return list
}

export function verdictFor(runId: string, requestedVersion?: string): TrajectoryVerdictResponse | null {
  const binding = loadRunBindings().find((b) => b.runId === runId)
  if (!binding) return liveVerdictFor(runId, requestedVersion)
  const contract = getContract(binding.contractId)
  if (!contract) return null
  // Contract version is part of the cache key: a version bump recomputes and
  // never mixes readings across versions (ADR-06 / F7-1 AC⑤).
  if (requestedVersion && requestedVersion !== contract.version) return null
  const key = `${runId}@${contract.version}`
  const hit = cache.get(key)
  if (hit) return envelope(hit, contract)
  const events = parseEvents(readFileSync(binding.file, 'utf8'))
  const verdict = evaluateEvents(contract, events, binding.source)
  cache.set(key, verdict)
  return envelope(verdict, contract)
}

/**
 * P2: evaluate a persisted Playground run against the task's live contract.
 *
 * - Only live/imported ids are looked up; fixture ids never touch sqlite.
 * - The judge score is not read, not written and not changed: the band only
 *   describes the process (terminal event is passed through untouched).
 * - The stream length + run status are part of the cache key because a still
 *   running run keeps appending events; a finished run hits the cache.
 */
function liveVerdictFor(runId: string, requestedVersion?: string): TrajectoryVerdictResponse | null {
  if (!/^(run_|imp_)/.test(runId)) return null
  let detail: ReturnType<typeof getRunDetail>
  try {
    detail = getRunDetail(runId)
  } catch {
    return null // no playground DB in this workspace — no verdict, no conclusion
  }
  if (!detail || detail.events.length === 0) return null
  const contract = getLiveContractForTask(detail.taskId)
  if (!contract) return null
  if (requestedVersion && requestedVersion !== contract.version) return null
  const key = `${runId}@live@${contract.version}@${detail.events.length}@${detail.status}`
  const hit = cache.get(key)
  if (hit) return envelope(hit, contract)
  const source: TrajectorySource = detail.source === 'imported' ? 'imported' : 'live'
  const verdict = evaluateEvents(contract, detail.events, source)
  cache.set(key, verdict)
  return envelope(verdict, contract)
}

export function verdictsFor(scope?: string): TrajectoryVerdictResponse[] {
  const out: TrajectoryVerdictResponse[] = []
  for (const b of loadRunBindings()) {
    if (scope === 'legal' ? !b.runId.startsWith('legal#') : scope === 'redteam' ? !b.runId.startsWith('redteam#') : scope ? !b.runId.startsWith(`${scope}#`) : false) continue
    const v = verdictFor(b.runId)
    if (v) out.push(v)
  }
  return out
}

// ---------------------------------------------------------------------------
// P2 statistics (same-question consistency + live-only stability).
// Reuses the same evaluator and the same contracts as the band, so a reading
// never differs between the run detail and the trajectory tab.
const readingCache = new Map<string, { stamp: string; readings: PilotRunReading[] }>()

/** One reading per recorded run of a pilot task. Read-only; never re-runs. */
export function pilotReadings(taskId: string): PilotRunReading[] {
  const contract = getLiveContractForTask(taskId)
  if (!contract) return []
  const runs = listRuns({ taskId, limit: 500 })
  // A cheap freshness stamp: run ids + statuses. A new/deleted run or a run
  // moving from running to scored must invalidate; createdAt alone would keep
  // serving the reading the panel saw while the run was still in flight.
  const stamp = runs.map((r) => `${r.runId}:${r.status}`).join('|')
  const hit = readingCache.get(taskId)
  if (hit && hit.stamp === stamp) return hit.readings

  const readings: PilotRunReading[] = []
  for (const r of runs) {
    const detail = getRunDetail(r.runId)
    if (!detail || detail.events.length === 0) continue
    const source = detail.source === 'imported' ? 'imported' : 'live'
    const v = evaluateEvents(contract, detail.events, source)
    readings.push({
      runId: r.runId,
      taskId,
      fingerprint: r.fingerprint,
      configLabel: r.configLabel,
      createdAt: r.createdAt,
      source,
      status: r.status,
      bucket: v.cell ?? (v.processIncomplete ? 'process-incomplete' : 'unknown'),
      cell: v.cell,
      hardViolation: v.hardViolation,
      softViolations: v.softViolations,
      csr: v.csr,
      firstDivergence: v.firstDivergence,
      pathSignature: v.pathSignature,
      matchedPath: v.matchedPath,
      terminalSuccess: v.terminalSuccess,
      judgeSuccess: r.success,
      judgeScore: r.score,
      missingCheckpoints: v.checkpoints.filter((c) => c.kind === 'required' && !c.completed && !c.unknown).map((c) => c.id),
    })
  }
  readingCache.set(taskId, { stamp, readings })
  return readings
}

export function consistencyFor(taskId: string): ConsistencyReport | null {
  const contract = getLiveContractForTask(taskId)
  if (!contract) return null
  return buildConsistency(pilotReadings(taskId), contract)
}

export function stabilityFor(taskId: string): StabilityReport | null {
  const contract = getLiveContractForTask(taskId)
  if (!contract) return null
  return buildStability(pilotReadings(taskId), contract)
}

/** One row per eval task — what the Playground trajectory tab lists. */
export function pilotSummary(): PilotTaskSummary[] {
  const out: PilotTaskSummary[] = []
  for (const c of loadLiveContracts()) {
    const taskId = c.target.id
    const con = consistencyFor(taskId)
    const sta = stabilityFor(taskId)
    if (!con || !sta) continue
    out.push({
      taskId,
      contractId: c.contractId,
      contractVersion: c.version,
      runs: pilotReadings(taskId).length,
      consistency: { agree: con.agree, compared: con.compared, verdict: con.verdict, suspects: con.suspects },
      stability: { runs: sta.runs, pooledPassK: sta.pooledPassK, dominantPath: sta.dominantPath, dominantShare: sta.dominantShare, groups: sta.groups },
    })
  }
  return out
}

function envelope(verdict: TrajectoryVerdictDetail, contract: TrajectoryContract): TrajectoryVerdictResponse {
  return {
    verdict,
    contract: {
      contractId: contract.contractId,
      version: contract.version,
      target: contract.target,
      author: contract.author,
      reviewer: contract.reviewer,
      pathCount: contract.allowedPaths.length,
      recoveryWindow: contract.recoveryWindow,
      checkpoints: contract.checkpoints.map((cp) => ({
        id: cp.id,
        kind: cp.kind,
        description: cp.description,
        ...(cp.window ? { windowLabel: cp.window.label } : {}),
      })),
      forbidden: contract.forbiddenActions.map((fa) => ({ id: fa.id, label: fa.label, severity: fa.severity, description: fa.description })),
    },
  }
}
