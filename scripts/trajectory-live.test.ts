// P2 live evaluation: one task-level contract per eval question (45 total),
// evaluated against persisted live runs. The judge score is never read or
// written here — these tests pin the contract corpus, the live wiring, and the
// two honest non-trusted readings (process-incomplete and fluke-success) that
// the trajectory layer exists to surface.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HarnessEvent } from '../shared/events'
import { cfg } from '../shared/config'
import { getLiveContractForTask, loadLiveContracts, loadContracts, verdictFor } from '../server/trajectoryStore'
import { appendEvent, insertRun, patchRun, useLiveDbPath } from '../server/playground/liveDb'
import { getTask } from '../server/playground/evalset'

const TASKS = loadLiveContracts().map((c) => c.target.id).sort()

test('45 live contracts load, validate, and target every eval task exactly once', () => {
  const files = readdirSync(resolve('data/trajectory/live-contracts')).filter((f) => f.endsWith('.json')).sort()
  assert.equal(files.length, 45)
  const contracts = loadLiveContracts()
  assert.equal(contracts.length, 45)
  assert.equal(new Set(contracts.map((c) => c.contractId)).size, 45)
  assert.equal(new Set(contracts.map((c) => c.target.id)).size, 45)
  for (const c of contracts) {
    assert.equal(c.target.kind, 'task', c.contractId)
    assert.equal(c.provenanceRule, 'live', c.contractId)
    assert.ok(getTask(c.target.id), `${c.contractId}: ${c.target.id} is not an eval task`)
    assert.ok(c.checkpoints.some((cp) => cp.kind === 'required'), c.contractId)
    assert.ok(c.completion.some((r) => r.requiredCheckpointsComplete === true), c.contractId)
    if (c.allowedPaths.length < 2) assert.ok(c.singlePathExemption, c.contractId)
  }
  // Live contracts live outside the fixture corpus: 16 fixture readings stay 16.
  assert.equal(loadContracts().length, 16)
  assert.equal(loadContracts().some((c) => c.target.kind === 'task'), false)
})

test('task lookup finds each task contract and nothing else', () => {
  for (const id of TASKS) assert.equal(getLiveContractForTask(id)?.target.id, id)
  assert.equal(getLiveContractForTask('G99'), undefined)
})

const BASE = { runId: 'run_live_test', scenarioId: 'sc', author: 'harness' as const }
let seq = 0
let currentRunId = BASE.runId
function ev(e: Record<string, unknown> & { type: string }): HarnessEvent {
  seq += 1
  return { ...BASE, runId: currentRunId, id: `le${seq}`, ts: seq * 10, ...e } as unknown as HarnessEvent
}

function seedRun(runId: string, taskId: string, events: HarnessEvent[]): void {
  currentRunId = runId
  const task = getTask(taskId)
  assert.ok(task, taskId)
  insertRun({
    runId,
    scenarioId: 'sc',
    taskId: task.id,
    taskTitle: task.title,
    domain: task.domain,
    split: task.split,
    presetId: 'C0',
    fingerprint: `fp-${runId}`,
    config: cfg(),
    mounts: {},
    provider: null,
    temperature: null,
    seed: null,
    maxTokens: null,
    source: 'live',
    materials: null,
    createdAt: new Date().toISOString(),
  })
  for (const e of events) appendEvent(runId, e)
  patchRun(runId, { status: 'scored', success: true, score: 1 })
}

test('a live run is evaluated against its task contract, with the judge result untouched', () => {
  useLiveDbPath(':memory:')
  const runId = 'run_live_g4'
  currentRunId = runId
  seedRun(runId, 'G4', [
    ev({ type: 'run.started', model: 'test', task: 'timeline' }),
    ev({ type: 'model.request', step: 1, blocks: [], estTokens: 10 }),
    ev({ type: 'tool.call', step: 1, tool: 'fs_read', argsSummary: 'dossier/第一次审查意见通知书.pdf' }),
    ev({ type: 'tool.result', step: 1, tool: 'fs_read', tokens: 10, summary: 'read 762 chars' }),
    ev({ type: 'model.request', step: 2, blocks: [], estTokens: 10 }),
    ev({ type: 'model.response', step: 2, thought: '程序节点：申请日 2024-03-15；第一次审查意见通知书 2024-08-15。', stopReason: 'end_turn' }),
    ev({ type: 'run.finished', success: true, tokens: 100, latencyP50: 10, failureModes: {} }),
  ])
  const r = verdictFor(runId)
  assert.ok(r, 'live verdict')
  assert.equal(r.verdict.source, 'live')
  assert.equal(r.verdict.runId, runId)
  assert.equal(r.contract.contractId, 'tc-task-g4-timeline')
  assert.equal(r.verdict.terminalSuccess, true)
  assert.equal(r.verdict.cell, 'trusted-success')
  assert.equal(r.verdict.csr, 1)
  assert.equal(r.verdict.processIncomplete, false)
  assert.equal(r.verdict.hardViolation, false)
  // Judge columns are not touched by the derivation.
  assert.equal(verdictFor(runId)?.verdict.cell, 'trusted-success')
  assert.equal(verdictFor(runId, '0.0.0'), null)
  assert.equal(verdictFor(runId, r.contract.version)?.verdict.cell, 'trusted-success')
})

test('success reported without the mandated evidence reads as process-incomplete, not trusted', () => {
  useLiveDbPath(':memory:')
  const runId = 'run_live_g4_short'
  currentRunId = runId
  seedRun(runId, 'G4', [
    ev({ type: 'run.started', model: 'test', task: 'timeline' }),
    ev({ type: 'model.request', step: 1, blocks: [], estTokens: 10 }),
    ev({ type: 'model.response', step: 1, thought: '程序节点：直接按常识回答。', stopReason: 'end_turn' }),
    ev({ type: 'run.finished', success: true, tokens: 100, latencyP50: 10, failureModes: {} }),
  ])
  const v = verdictFor(runId)!.verdict
  assert.equal(v.terminalSuccess, true)
  assert.equal(v.processIncomplete, true)
  assert.equal(v.cell, null)
  assert.equal(v.csr, 0.5)
  assert.equal(v.hardViolation, false)
  assert.equal(v.firstDivergence, null)
})

test('a harness with no auditor reads unknown — never a fabricated "unaudited submission"', () => {
  useLiveDbPath(':memory:')
  const runId = 'run_live_g11_noaudit'
  currentRunId = runId
  seedRun(runId, 'G11', [
    ev({ type: 'run.started', model: 'test', task: 'checklist' }),
    ev({ type: 'model.request', step: 1, blocks: [], estTokens: 10 }),
    ev({ type: 'model.response', step: 1, thought: '审理意见：以下是要点清单。', stopReason: 'end_turn' }),
    ev({ type: 'run.finished', success: true, tokens: 100, latencyP50: 10, failureModes: {} }),
  ])
  const v = verdictFor(runId)!.verdict
  assert.equal(v.terminalSuccess, true, 'terminal success is passed through unchanged')
  assert.equal(v.hardViolation, false, 'no auditor mounted ⇒ the submission cannot be called unaudited')
  assert.equal(v.cell, null)
  assert.equal(v.processIncomplete, false)
  assert.equal(v.checkpoints.find((c) => c.id === 'cp-audit')?.unknown, true)
})

test('a live run that submits after a rejected citation audit reads as fluke-success', () => {
  useLiveDbPath(':memory:')
  const runId = 'run_live_g11'
  currentRunId = runId
  seedRun(runId, 'G11', [
    ev({ type: 'run.started', model: 'test', task: 'checklist' }),
    ev({ type: 'model.request', step: 1, blocks: [], estTokens: 10 }),
    ev({ type: 'model.response', step: 1, thought: '审理意见：以下是要点清单。', stopReason: 'end_turn' }),
    ev({ type: 'verifier.verdict', step: 1, verifier: 'citation-audit', verdict: 'reject', reason: 'fabricated article' }),
    ev({ type: 'run.finished', success: true, tokens: 100, latencyP50: 10, failureModes: {} }),
  ])
  const v = verdictFor(runId)!.verdict
  assert.equal(v.terminalSuccess, true, 'terminal success is passed through unchanged')
  assert.equal(v.hardViolation, true)
  assert.equal(v.cell, 'fluke-success')
  assert.equal(v.steps.find((s) => s.ruleId === 'xf-unaudited-submit')?.verdict, 'violating')
})

test('a run without a task contract yields no verdict — never a fabricated one', () => {
  useLiveDbPath(':memory:')
  // Every eval task now carries a contract, so the no-contract case is a task
  // id that is not in the eval set at all (e.g. a hand-made or future run).
  const runId = 'run_live_uncontracted'
  currentRunId = runId
  insertRun({
    runId,
    scenarioId: 'sc',
    taskId: 'G99',
    taskTitle: 'not an eval task',
    domain: 'general',
    split: 'repair',
    presetId: 'C0',
    fingerprint: `fp-${runId}`,
    config: cfg(),
    mounts: {},
    provider: null,
    temperature: null,
    seed: null,
    maxTokens: null,
    source: 'live',
    materials: null,
    createdAt: new Date().toISOString(),
  })
  appendEvent(runId, ev({ type: 'run.started', model: 'test', task: 'other' }))
  appendEvent(runId, ev({ type: 'run.finished', success: true, tokens: 10, latencyP50: 10, failureModes: {} }))
  assert.equal(verdictFor(runId), null)
  assert.equal(verdictFor('run_does_not_exist'), null)
  assert.equal(verdictFor('imported#whatever'), null)
})
