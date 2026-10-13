import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseExternalImport } from '../server/playground/importFormat'

test('external imports never trust the foreign success verdict', () => {
  const claude = parseExternalImport(readFileSync(resolve('data/imports/claude-sample.jsonl'), 'utf8'))
  assert.equal(claude.formats[0], 'claude')
  assert.equal(claude.items.length, 1)
  assert.equal(claude.items[0].run.source, 'imported')
  assert.equal(claude.items[0].run.success, null)
  assert.equal(claude.items[0].run.score, null)
  assert.equal(claude.items[0].run.verdict, null)
  assert.ok(claude.items[0].events.length > 0)
  assert.ok(claude.items[0].run.answer && claude.items[0].run.answer.length > 0)

  const dsh = parseExternalImport(readFileSync(resolve('data/imports/dsh-sample.json'), 'utf8'))
  assert.equal(dsh.formats[0], 'dsh')
  assert.equal(dsh.items[0].run.source, 'imported')
  assert.equal(dsh.items[0].run.success, null)
  assert.ok(dsh.items[0].events.length > 0)
})

test('external runs land unlinked and on the bare config rung', () => {
  const r = parseExternalImport(readFileSync(resolve('data/imports/dsh-sample.json'), 'utf8'))
  const run = r.items[0].run
  assert.equal(run.taskId, 'IMPORTED')
  assert.equal(run.domain, 'general')
  assert.equal(run.configVersion.ladderRung, 'bare')
  // Baseline config: we cannot claim a foreign trajectory used any of our controls.
  const flat = [
    ...Object.values(run.configVersion.controlsSnapshot.security),
    ...Object.values(run.configVersion.controlsSnapshot.legal),
  ]
  for (const v of flat) assert.equal(v, false)
})

test('hwt TXT report is parsed lossily (answer only, no events)', () => {
  const txt = [
    'HWT Playground Live Run（TXT 导出）',
    'task         : [L1] 三件专利新颖性对比',
    'domain/split : legal / repair',
    'model        : gpt-x',
    '──────────────────────────────────────────────────────────── answer',
    '这是最终答复。',
    '──────────────────────────────────────────────────────────── trajectory',
    '[x] step1',
  ].join('\n')
  const r = parseExternalImport(txt)
  assert.equal(r.formats[0], 'txt')
  assert.equal(r.items[0].run.taskId, 'L1')
  assert.equal(r.items[0].run.domain, 'legal')
  assert.equal(r.items[0].run.split, 'repair')
  assert.equal(r.items[0].run.answer, '这是最终答复。')
  assert.equal(r.items[0].events.length, 0)
  assert.equal(r.items[0].run.success, null)
})

test('plain text becomes an unlinked answer', () => {
  const r = parseExternalImport('一段完全没有结构的文本，当作答复。')
  assert.equal(r.formats[0], 'txt')
  assert.equal(r.items[0].run.taskId, 'IMPORTED')
  assert.equal(r.items[0].run.answer, '一段完全没有结构的文本，当作答复。')
  assert.equal(r.items[0].run.success, null)
})

test('empty input rejects', () => {
  assert.throws(() => parseExternalImport('   \n'), /empty/)
})
