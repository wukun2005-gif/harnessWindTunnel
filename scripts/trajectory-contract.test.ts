import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { event as eventSchema } from '../shared/events'
import { trajectoryContract, type TrajectoryContract } from '../shared/trajectory'
import { loadContracts } from '../server/trajectoryStore'

const base = (over: Record<string, unknown> = {}): unknown => ({
  contractId: 'tc-valid', target: { kind: 'scenario', id: 'scenario-test' }, version: '1.0.0',
  author: 'a', reviewer: 'r',
  checkpoints: [{ id: 'cp-a', kind: 'required', observable: { eventTypes: ['tool.call'], match: { tool: 'a' } }, description: 'A' }],
  allowedPaths: [{ id: 'p1', nodes: ['cp-a'], edges: [] }],
  allowedActions: [], forbiddenActions: [],
  completion: [{ id: 'done', terminal: { success: true }, description: 'done' }],
  recoveryWindow: 2, provenanceRule: 'fixture', singlePathExemption: 'one physical order',
  ...over,
})

test('16 contracts load and validate; targets are unique and versioned', () => {
  const files = readdirSync(resolve('data/trajectory/contracts')).filter((f) => f.endsWith('.json')).sort()
  assert.equal(files.length, 16)
  const contracts = loadContracts()
  assert.equal(contracts.length, 16)
  assert.equal(new Set(contracts.map((c) => c.contractId)).size, 16)
  assert.equal(new Set(contracts.map((c) => `${c.target.kind}:${c.target.id}`)).size, 16)
  assert.equal(contracts.filter((c) => c.target.kind === 'scenario').length, 5)
  assert.equal(contracts.filter((c) => c.target.kind === 'dossier').length, 5)
  assert.equal(contracts.filter((c) => c.target.kind === 'attack').length, 6)
  for (const c of contracts) {
    assert.match(c.version, /^\d+\.\d+\.\d+$/, c.contractId)
    assert.ok(c.author.length > 0 && c.reviewer.length > 0, c.contractId)
    assert.equal(c.provenanceRule, 'fixture', c.contractId)
    assert.ok(c.checkpoints.some((cp) => cp.kind === 'required'), `${c.contractId} needs a required checkpoint`)
    assert.ok(c.checkpoints.every((cp) => cp.observable.eventTypes.length > 0), `${c.contractId} checkpoint without an observable`)
    assert.ok(c.forbiddenActions.every((fa) => fa.label.length > 0 && (fa.severity === 'hard' || fa.severity === 'soft')), `${c.contractId} forbidden action without label/severity`)
    for (const p of c.allowedPaths) {
      for (const n of p.nodes) assert.ok(c.checkpoints.some((cp) => cp.id === n), `${c.contractId}/${p.id}: ${n} is not a checkpoint`)
    }
  }
})

test('the runtime event type set is unchanged: no trajectory-verdict event type exists', () => {
  const types = eventSchema.options.map((o) => o.shape.type.value).sort()
  assert.deepEqual(types, [
    'agent.fork', 'agent.join', 'compact.boundary', 'failure.tag', 'harness.mutation',
    'hook.decision', 'legal.assertion', 'model.request', 'model.response', 'optimizer.fire',
    'permission.denied', 'permission.granted', 'permission.request', 'router.decision',
    'run.finished', 'run.started', 'sensor.lint', 'shaper.fire', 'tool.call', 'tool.result',
    'verifier.verdict',
  ])
  assert.equal(types.some((t) => /trajectory|verdict\.trajectory|tvc/.test(t)), false)
})

test('multi-path tasks carry at least two walks that differ in nodes or edges', () => {
  for (const c of loadContracts()) {
    if (c.allowedPaths.length < 2) {
      assert.ok(c.singlePathExemption, `${c.contractId}: single path requires an exemption note`)
      continue
    }
    const sig = (p: TrajectoryContract['allowedPaths'][number]) =>
      JSON.stringify({ n: [...p.nodes].sort(), e: [...p.edges].map(([a, b]) => `${a}>${b}`).sort() })
    assert.equal(new Set(c.allowedPaths.map(sig)).size, c.allowedPaths.length, `${c.contractId}: duplicate allowed paths`)
  }
})

test('schema rejects a contract without a completion rule', () => {
  assert.throws(() => trajectoryContract.parse(base({ completion: [] })), /at least one|too_small/i)
})

test('schema rejects a single allowed path without an exemption note', () => {
  const raw = base() as Record<string, unknown>
  delete raw.singlePathExemption
  assert.throws(() => trajectoryContract.parse(raw), /singlePathExemption|substantially different/i)
})

test('schema accepts a single allowed path only with an exemption note', () => {
  assert.doesNotThrow(() => trajectoryContract.parse(base()))
})

test('schema rejects duplicate allowed walks', () => {
  const raw = base({
    allowedPaths: [
      { id: 'p1', nodes: ['cp-a'], edges: [] },
      { id: 'p2', nodes: ['cp-a'], edges: [] },
    ],
  })
  assert.throws(() => trajectoryContract.parse(raw), /duplicate walks|substantially different/i)
})

test('schema rejects checkpoints bound to absolute step numbers or timestamps', () => {
  for (const key of ['step', 'ts', 'id']) {
    const raw = base({
      checkpoints: [{
        id: 'cp-a', kind: 'required',
        observable: { eventTypes: ['tool.call'], match: { [key]: '1' } },
        description: 'A',
      }],
    })
    assert.throws(() => trajectoryContract.parse(raw), /absolute position|step numbers/i, key)
  }
  const windowBound = base({
    checkpoints: [{
      id: 'cp-a', kind: 'required',
      observable: { eventTypes: ['tool.call'], match: { tool: 'a' } },
      window: { closesWith: { eventTypes: ['model.response'], match: { step: '2' } }, label: 'close' },
      description: 'A',
    }],
  })
  assert.throws(() => trajectoryContract.parse(windowBound), /absolute position|step numbers/i)
})

test('schema rejects duplicate checkpoint ids, missing required checkpoints, cycles and unknown nodes', () => {
  const dup = base({
    checkpoints: [
      { id: 'cp-a', kind: 'required', observable: { eventTypes: ['tool.call'], match: { tool: 'a' } }, description: 'A' },
      { id: 'cp-a', kind: 'optional', observable: { eventTypes: ['tool.call'], match: { tool: 'b' } }, description: 'B' },
    ],
  })
  assert.throws(() => trajectoryContract.parse(dup), /duplicate checkpoint id/i)

  const optionalOnly = base({
    checkpoints: [{ id: 'cp-a', kind: 'optional', observable: { eventTypes: ['tool.call'], match: { tool: 'a' } }, description: 'A' }],
  })
  assert.throws(() => trajectoryContract.parse(optionalOnly), /required checkpoint/i)

  const cycle = base({
    checkpoints: [
      { id: 'cp-a', kind: 'required', observable: { eventTypes: ['tool.call'], match: { tool: 'a' } }, description: 'A' },
      { id: 'cp-b', kind: 'required', observable: { eventTypes: ['tool.call'], match: { tool: 'b' } }, description: 'B' },
    ],
    allowedPaths: [
      { id: 'p1', nodes: ['cp-a', 'cp-b'], edges: [['cp-a', 'cp-b'], ['cp-b', 'cp-a']] },
      { id: 'p2', nodes: ['cp-a'], edges: [] },
    ],
  })
  assert.throws(() => trajectoryContract.parse(cycle), /cycle/i)

  const unknownNode = base({
    allowedPaths: [
      { id: 'p1', nodes: ['cp-a', 'cp-z'], edges: [] },
      { id: 'p2', nodes: ['cp-a'], edges: [] },
    ],
  })
  assert.throws(() => trajectoryContract.parse(unknownNode), /not a checkpoint/i)
})

test('schema rejects failure.tag as an observable event type', () => {
  const raw = base({
    checkpoints: [{ id: 'cp-a', kind: 'required', observable: { eventTypes: ['failure.tag'] }, description: 'A' }],
  })
  assert.throws(() => trajectoryContract.parse(raw))
})

test('contracts never leak into the agent context (model.request blocks)', () => {
  const contracts = loadContracts()
  const forbidden = new Set(contracts.flatMap((c) => [c.contractId, ...c.checkpoints.map((cp) => cp.id)]))
  const branch = readFileSync(resolve('data/scenarios/writing-q3-report/branches/fivelayer.jsonl'), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line))
    .find((e) => e.type === 'model.request')
  const payload = JSON.stringify(branch.blocks)
  for (const token of forbidden) assert.ok(!payload.includes(token), `model.request context leaked ${token}`)
})
