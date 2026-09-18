import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { fixture, t, variantLabel } from '../src/i18n'
import { deriveRun } from '../src/lib/derive'
import type { HarnessEvent } from '../shared/events'

const source = readFileSync(resolve('src/i18n.ts'), 'utf8')
const ast = ts.createSourceFile('i18n.ts', source, ts.ScriptTarget.Latest, true)
const dictionaries: Record<string, Record<string, string>> = {}
ast.forEachChild((node) => {
  if (!ts.isVariableStatement(node)) return
  for (const declaration of node.declarationList.declarations) {
    const name = declaration.name.getText(ast)
    if (!['en', 'zh', 'fixtureEn', 'fixtureZh'].includes(name)) continue
    assert.ok(declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer))
    dictionaries[name] = {}
    for (const prop of declaration.initializer.properties) {
      assert.ok(ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.name) && ts.isStringLiteral(prop.initializer))
      assert.ok(!(prop.name.text in dictionaries[name]), `Duplicate ${name} key: ${prop.name.text}`)
      dictionaries[name][prop.name.text] = prop.initializer.text
    }
  }
})

const han = /\p{Script=Han}|\uFFFD/u
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

test('generated labels follow Chinese → English → Chinese without mutating stored labels', () => {
  for (const label of ['配置 1', '配置 12', 'Variant 3', '+ Verifier', 'custom label']) {
    assert.equal(variantLabel(label, 'zh'), label)
    assert.equal(variantLabel(label, 'en'), label.replace(/^配置 (\d+)$/, 'Variant $1'))
    assert.equal(variantLabel(label, 'zh'), label)
  }
})

test('all English UI keys exist, contain no Chinese, and preserve interpolation parameters', () => {
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries.zh).sort())
  for (const [key, value] of Object.entries(dictionaries.en)) {
    assert.ok(!han.test(value), `${key}: ${value}`)
    assert.equal(t(key, 'en'), value)
    const params = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    assert.deepEqual(params(value), params(dictionaries.zh[key]), key)
  }
  assert.equal(t('tunnel.readings.approximate', 'en', { distance: 3 }).includes('{distance}'), false)
})

test('Demo wrap-up does not promise ten recorded generations; Chinese title stays unchanged', () => {
  assert.equal(t('demo.step12.title', 'en'), 'Evolution Replay (69.7% → 77.0%): Wrap-up')
  assert.equal(t('demo.step12.title', 'zh'), '自动播放 10 代 (69.7% → 77.0%) 总结')
})

test('English replay entries never return Chinese, including every formerly inverted entry', () => {
  for (const [key, value] of Object.entries(dictionaries.fixtureEn)) {
    assert.ok(!han.test(value), `${key}: ${value}`)
    assert.equal(fixture(key, 'en'), value)
  }
  assert.equal(fixture('First reproduce the flaky test', 'en'), 'First reproduce the flaky test')
  assert.equal(fixture('First reproduce the flaky test', 'zh'), '首先复现不稳定测试')
  assert.equal(fixture('Run succeeded', 'en'), 'Run succeeded')
  assert.equal(fixture('Run succeeded', 'zh'), '运行成功')
  assert.equal(fixture('unknown tool identifier', 'en'), 'unknown tool identifier')
})

test('Chinese dictionaries match the pre-fix baseline exactly', () => {
  const raw = readFileSync(resolve('scripts/fixtures/i18n-zh-baseline.json'), 'utf8')
  const baseline = JSON.parse(raw.slice(raw.indexOf('{')))
  assert.deepEqual(dictionaries.zh, baseline.zh)
  assert.deepEqual(dictionaries.fixtureZh, baseline.fixtureZh)
})

test('all scenario metadata, replay steps, markers, context previews, and Forge data remain English', () => {
  const root = resolve('data')
  const seen = new Set<string>()
  // data/imports holds upload samples, not recorded replay branches — checked for language, excluded from the branch index.
  const isImportSample = (path: string) => path.startsWith(resolve(root, 'imports'))
  for (const path of files(root)) {
    if (isImportSample(path)) {
      const values: unknown = path.endsWith('.jsonl')
        ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        : JSON.parse(readFileSync(path, 'utf8'))
      for (const value of strings(values)) assert.ok(!han.test(fixture(value, 'en')), `${path}: ${value}`)
      continue
    }
    let values: unknown
    if (path.endsWith('.jsonl')) {
      const events = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) as HarnessEvent[]
      values = [events, deriveRun(events)]
      seen.add(path.slice(root.length + 1))
    } else if (path.endsWith('.json')) {
      values = JSON.parse(readFileSync(path, 'utf8'))
    } else continue
    for (const value of strings(values)) assert.ok(!han.test(fixture(value, 'en')), `${path}: ${value}`)
  }
  // Recorded branches == files referenced by scenario metas (no missing, no orphans).
  const expected = new Set<string>()
  for (const entry of readdirSync(resolve(root, 'scenarios'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const meta = JSON.parse(readFileSync(resolve(root, 'scenarios', entry.name, 'meta.json'), 'utf8')) as { branches: { file: string }[] }
    for (const b of meta.branches) if (b.file) expected.add(`scenarios/${entry.name}/branches/${b.file}`)
  }
  assert.deepEqual([...seen].sort(), [...expected].sort())
})
