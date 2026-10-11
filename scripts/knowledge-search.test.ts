// 知识库检索（knowledgeSearch → hybridSearch → rerank）离线单测：不打任何真实网络。
// 回归钉死 L3 反编造实跑暴露的两个缺陷：
//   ① RRF 融合后 candidate.score 是名次分（~1/(60+rank)）而不是余弦相似度，本地重排的
//      「语义相似度」信号被清零 → 词面相似的错误文档压过真正相关的条文（实测假司法解释
//      top 0.96、真法条 0.28 的分数倒挂）。修复后语义信号恢复主导。
//   ② MCP 检索工具把近邻结果说成「命中」：库里没有对应条文时向量检索照样返回最相似的
//      k 条，「5 条命中（top 0.96）」会被 agent 读成「条文存在」。措辞必须是「相似片段」
//      并显式指向 patent_law_verify_citation。
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env['HWT_SETTINGS_FILE'] = join(mkdtempSync(join(tmpdir(), 'hwt-kb-')), 'settings.json')

const { resetKnowledgeDbForTesting, addSource, addChunks, addVectors, closeKnowledgeDb } = await import('../server/knowledge/db')
const { invalidateBM25Index } = await import('../server/knowledge/bm25')
const { knowledgeSearch } = await import('../server/knowledge/search')
const { putRetrievalSettings } = await import('../server/knowledge/settings')
const { callPatentLawTool } = await import('../server/playground/patentLawMcp')

// ── 假 HTTP 层：只应答 embedding 端点（查询向量固定），其余一律报错 ─────────

const QUERY_VEC = [1, 0, 0, 0]
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : String((input as Request).url)
  if (url.includes('/embeddings')) {
    return new Response(JSON.stringify({ data: [{ embedding: QUERY_VEC }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response(`unexpected outbound call: ${url}`, { status: 500 })
}) as typeof globalThis.fetch

after(() => {
  globalThis.fetch = realFetch
  closeKnowledgeDb()
})

// ── 语料：两条 chunk 词面信号完全相同，只有语义向量不同 ────────────────────
// c-real 与查询同向（cosine ≈ 1）；c-bait 正交（cosine = 0，被向量闸门筛掉，只能经
// BM25 进候选）。关键词匹配 / 文档类型 / 条号 / 深度四个信号两条完全一样，排序只能由
// 语义信号决定——语义信号被清零时两条分数几乎相等，词面诱饵会排到第一。

resetKnowledgeDbForTesting(':memory:')
invalidateBM25Index()
addSource({ id: 'src', name: 'test-src', type: 'file', format: 'md', mediaType: 'text/markdown', size: 1, chunkCount: 2, embedStatus: 'done' })
addChunks([
  { id: 'c-real', sourceId: 'src', index: 0, text: '创造性。三步法。第一步，确定最接近的现有技术。', strategy: 'test', metadata: {} },
  { id: 'c-bait', sourceId: 'src', index: 1, text: '创造性。三步法。在审查实践中的其他表述。', strategy: 'test', metadata: {} },
])
addVectors([
  { chunkId: 'c-real', vector: [1, 0.05, 0, 0], modelId: 'm' },
  { chunkId: 'c-bait', vector: [0, 0, 1, 0], modelId: 'm' },
])
invalidateBM25Index()

const emb = { providerId: 'test-emb', baseUrl: 'https://emb.test/v1', apiKey: 'kb-key', modelId: 'kb-model' }

test('rerank receives the true cosine score, so a lexically identical bait chunk cannot outrank the real one', async () => {
  putRetrievalSettings({ knowledgeProviders: [{ providerType: 'embedding', ...emb, enabled: true }] })
  const hits = await knowledgeSearch('创造性 三步法', emb, { topK: 5, useRerank: false })
  assert.equal(hits.length, 2)
  assert.equal(hits[0]!.chunkId, 'c-real', '语义信号被清零时词面诱饵排到第一——倒挂回归钉死')
  const gap = hits[0]!.score - hits[1]!.score
  assert.ok(gap >= 0.1, `真实余弦 ≈1 的 chunk 应明显拉开分差，实际 ${gap.toFixed(4)}`)
})

test('MCP search reports similar fragments, not hits, and points at verify_citation before citing', async () => {
  const r = await callPatentLawTool('patent_law_search', { query: '创造性 三步法' })
  assert.equal(r.ok, true, JSON.stringify(r.data))
  assert.ok(r.summary.includes('相似片段'), r.summary)
  assert.ok(!r.summary.includes('命中'), r.summary)
  assert.ok(r.summary.includes('patent_law_verify_citation'), r.summary)
  const d = r.data as { results: Array<{ chunkId: string }> }
  assert.equal(d.results[0]?.chunkId, 'c-real')
})
