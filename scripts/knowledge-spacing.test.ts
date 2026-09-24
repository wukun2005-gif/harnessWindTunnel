// 汉字间空格归一化 + 文本修正落库单测（M0 入库缺陷修复）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeCjkSpacing } from '../server/knowledge/preprocess'
import {
  addChunks,
  addSource,
  addVectors,
  closeKnowledgeDb,
  computeTextHash,
  findChunksByHashes,
  getAllChunks,
  markChunkEmbedded,
  resetKnowledgeDbForTesting,
  updateChunkTextAndInvalidate,
} from '../server/knowledge/db'

test('only whitespace between two cjk chars is removed', () => {
  assert.equal(normalizeCjkSpacing('复 审 请求'), '复审请求')
  assert.equal(normalizeCjkSpacing('第 22 条'), '第 22 条')
  assert.equal(normalizeCjkSpacing('patent law'), 'patent law')
  assert.equal(normalizeCjkSpacing('复审\n请求'), '复审请求')
  assert.equal(normalizeCjkSpacing('形 \n\n 经'), '形经')
  assert.equal(normalizeCjkSpacing('决定。\n\n复审'), '决定。\n\n复审')
  assert.equal(normalizeCjkSpacing('已 clean'), '已 clean')
  assert.equal(normalizeCjkSpacing('复审请求'), '复审请求')
  // 幂等。
  const once = normalizeCjkSpacing('复 审\n请求')
  assert.equal(normalizeCjkSpacing(once), once)
})

test('text fix updates hash, drops stale vectors and resets the embed flag', () => {
  resetKnowledgeDbForTesting(join(mkdtempSync(join(tmpdir(), 'hwt-kb-')), 'knowledge.db'))
  try {
    addSource({ id: 's1', name: 't.txt', type: 'file', format: 'txt', mediaType: 'text/plain', size: 0, chunkCount: 0, embedStatus: 'pending' })
    addChunks([{ id: 'c1', sourceId: 's1', index: 0, text: '复 审 请求', strategy: 'auto', metadata: {} }])
    addVectors([{ chunkId: 'c1', vector: [0.1, 0.2], modelId: 'm' }])
    markChunkEmbedded('c1')
    const oldHash = computeTextHash('复 审 请求')
    assert.ok(findChunksByHashes([oldHash]).has(oldHash), 'vector present before fix')
    assert.equal(updateChunkTextAndInvalidate('c1', '复 审 请求'), false)
    assert.equal(updateChunkTextAndInvalidate('c1', '复审请求'), true)
    const [row] = getAllChunks()
    assert.equal(row!.text, '复审请求')
    assert.equal(row!.embedded, 0)
    assert.notEqual(row!.textHash, null)
    // 旧向量已删（按旧 hash 查不到），短 chunk 路径不受影响。
    assert.ok(!findChunksByHashes([oldHash]).has(oldHash), 'stale vector dropped')
    assert.equal(updateChunkTextAndInvalidate('nope', 'x'), false)
  } finally {
    closeKnowledgeDb()
  }
})
