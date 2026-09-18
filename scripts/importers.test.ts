import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseClaudeCodeTranscript } from '../server/importers/claudeCode'
import { parseDshTrajectory } from '../server/importers/dshTrajectory'
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
