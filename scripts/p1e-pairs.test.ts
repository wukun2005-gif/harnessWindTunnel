// P1-E 检索对单测（M1 场景扩展）：不断网。
// 覆盖：pairs 文件 schema（17 组、queryId 唯一、金标非空、出处标记齐备）、
// 召回计算（命中计数、空金标、均值）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ragRecall } from '../src/screens/Playground/analysis'

test('retrieval pairs hold 17 queries with gold chunks and provenance', () => {
  const doc = JSON.parse(readFileSync(resolve('data/playground/evalset-retrieval-pairs.json'), 'utf8')) as {
    total: number
    pairs: Array<{ queryId: string; query: string; newChunkIds: string[]; goldSource?: string; goldConfidence?: string; thinReason?: string }>
  }
  assert.equal(doc.total, 17)
  assert.equal(doc.pairs.length, 17)
  assert.equal(new Set(doc.pairs.map((p) => p.queryId)).size, 17)
  for (const p of doc.pairs) {
    assert.ok(p.query, `${p.queryId} query`)
    assert.ok(p.newChunkIds.length > 0, `${p.queryId} gold`)
    assert.ok(p.goldSource === 'text-matched' || p.goldSource === 'article-derived', `${p.queryId} provenance`)
  }
  const thin = doc.pairs.filter((p) => p.goldConfidence === 'thin')
  assert.deepEqual(thin.map((p) => p.queryId), ['gs-aeabccf9'])
})

test('rag recall counts gold hits, empty gold yields null', () => {
  assert.deepEqual(ragRecall(['a', 'b'], ['a', 'x']), { hit: 1, total: 2, rate: 0.5 })
  assert.deepEqual(ragRecall(['a'], ['a']), { hit: 1, total: 1, rate: 1 })
  assert.deepEqual(ragRecall([], ['a']), { hit: 0, total: 0, rate: null })
})
