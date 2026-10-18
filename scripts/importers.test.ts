import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseClaudeCodeTranscript } from '../server/importers/claudeCode'
import { parseDshTrajectory } from '../server/importers/dshTrajectory'
import { parsePlaygroundRun } from '../server/importers/playgroundRun'
import { exportNlah, importNlah } from '../server/importers/nlah'
import { cfg } from '../shared/config'

const kinds = (events: { type: string }[]) => events.map((e) => e.type)

test('claude sample normalizes to a playable event stream', () => {
  const raw = readFileSync(resolve('data/imports/claude-sample.jsonl'), 'utf8')
  const { events, skipped } = parseClaudeCodeTranscript(raw)
  const k = kinds(events)
  assert.equal(k[0], 'run.started')
  assert.equal(k[k.length - 1], 'run.finished')
  assert.ok(k.includes('model.request'))
  assert.ok(k.includes('model.response'))
  assert.ok(k.includes('tool.call'))
  assert.ok(k.includes('tool.result'))
  // 3 assistant turns → 3 requests; 2 tool uses → 2 calls + 2 results
  assert.equal(k.filter((x) => x === 'model.request').length, 3)
  assert.equal(k.filter((x) => x === 'tool.call').length, 2)
  assert.equal(k.filter((x) => x === 'tool.result').length, 2)
  assert.equal(skipped, 0)
  const req = events.find((e) => e.type === 'model.request')!
  assert.ok(req.type === 'model.request' && req.blocks.length > 0 && req.estTokens > 0)
})

test('claude parser tolerates garbage lines and empty input', () => {
  const { events, skipped } = parseClaudeCodeTranscript('not json\n{"nope":1}\n')
  assert.deepEqual(events, [])
  assert.equal(skipped, 2)
})

test('dsh sample normalizes, unknown shapes reject', () => {
  const doc = JSON.parse(readFileSync(resolve('data/imports/dsh-sample.json'), 'utf8'))
  const { events } = parseDshTrajectory(doc)
  const k = kinds(events)
  assert.equal(k[0], 'run.started')
  assert.equal(k[k.length - 1], 'run.finished')
  assert.equal(k.filter((x) => x === 'model.request').length, 3)
  assert.equal(k.filter((x) => x === 'tool.call').length, 2)
  assert.throws(() => parseDshTrajectory({}), /steps array/)
  assert.throws(() => parseDshTrajectory(null), /steps array/)
})

test('playground run export keeps the stream playable and restamps provenance', () => {
  const base = { runId: 'run_x', scenarioId: 'legal', author: 'harness' }
  const envelope = {
    kind: 'hwt-playground-run',
    schemaVersion: 1,
    run: { runId: 'run_x', taskTitle: '定最接近的现有技术', model: 'nemotron' },
    events: [
      { ...base, type: 'run.started', model: 'nemotron', task: '定最接近的现有技术', id: 'e1', ts: 1 },
      { ...base, type: 'model.request', step: 1, blocks: [], estTokens: 4, id: 'e2', ts: 2 },
      { ...base, type: 'model.response', step: 1, thought: 'hi', stopReason: 'end_turn', id: 'e3', ts: 3 },
      { ...base, type: 'run.finished', success: false, tokens: 4, latencyP50: 1, failureModes: { 'weak-grounding': 1 }, id: 'e4', ts: 4 },
      { type: 'nope.bogus' },
    ],
  }
  const { events, skipped } = parsePlaygroundRun(JSON.stringify(envelope))
  const k = kinds(events)
  assert.equal(k[0], 'run.started')
  assert.equal(k[k.length - 1], 'run.finished')
  assert.equal(events.length, 4)
  assert.equal(skipped, 1)
  // External trajectories are never harness interventions (shared/events.ts §provenance)
  assert.ok(events.every((e) => e.author === 'imported'))
  assert.ok(events.every((e) => e.scenarioId === 'imported'))
  // An array of envelopes (multi-run export) flattens into one replay
  const two = parsePlaygroundRun(JSON.stringify([envelope, envelope]))
  assert.equal(two.events.length, 8)
  // A truncated export that never started still yields a replay header
  const headless = parsePlaygroundRun(JSON.stringify({ kind: 'hwt-playground-run', run: { taskTitle: 'T', model: 'm' }, events: envelope.events.slice(1, 3) }))
  assert.equal(kinds(headless.events)[0], 'run.started')
  const head = headless.events[0]
  assert.ok(head?.type === 'run.started' && head.task === 'T')
  assert.throws(() => parsePlaygroundRun('{"kind":"nope","events":[]}'), /hwt-playground-run/)
  assert.throws(() => parsePlaygroundRun('{"kind":"hwt-playground-run"}'), /events array/)
  assert.throws(() => parsePlaygroundRun('not json'), /JSON document/)
})

test('NLAH export → import round-trips exactly', () => {
  const config = cfg({ filesystem: 'file-backed-state', sensors: 'verifier', permissions: 'ask-write' })
  const back = importNlah(JSON.parse(JSON.stringify(exportNlah(config, 'Do the thing'))))
  assert.deepEqual(back.config, config)
  assert.equal(back.task, 'Do the thing')
})

test('NLAH import rejects off-spectrum input', () => {
  assert.throws(() => importNlah({}), /object|format/)
  assert.throws(() => importNlah({ format: 'nlah-harness/9', task: 't', modules: {} }), /unsupported/)
  const bad = exportNlah(cfg(), 't') as unknown as { modules: Record<string, string> }
  bad.modules['toolset'] = 'turbo-ultra'
  assert.throws(() => importNlah(bad), /off-spectrum/)
})
