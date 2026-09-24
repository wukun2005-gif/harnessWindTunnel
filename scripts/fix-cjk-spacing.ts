// 一次性迁移：修复指南 PDF 的汉字间逐字空格（M0 入库缺陷）。
// 流程：归一化文本 → 更新文本/hash/作废旧向量 → 重嵌（<50 字标 embedded 跳过向量）。
// 用法：npx tsx scripts/fix-cjk-spacing.ts（幂等：干净 chunk 自动跳过）。
import { MIN_EMBED_LENGTH } from '../shared/knowledge'
import {
  addVectors,
  getAllChunks,
  markChunkEmbedded,
  updateChunkTextAndInvalidate,
} from '../server/knowledge/db'
import { createRemoteEmbedder } from '../server/knowledge/embed'
import { normalizeCjkSpacing } from '../server/knowledge/preprocess'
import { embedderConfig } from '../server/knowledge/settings'

const changed: Array<{ id: string; text: string }> = []
for (const c of getAllChunks()) {
  const cleaned = normalizeCjkSpacing(c.text)
  if (cleaned !== c.text && updateChunkTextAndInvalidate(c.id, cleaned)) {
    changed.push({ id: c.id, text: cleaned })
  }
}
console.log(`fixed text: ${changed.length}`)

const emb = embedderConfig()
if (!emb) {
  console.log('no embedding provider configured — vectors left empty, BM25 only')
  process.exit(0)
}
const toEmbed = changed.filter((c) => c.text.length >= MIN_EMBED_LENGTH)
for (const c of changed) {
  if (c.text.length < MIN_EMBED_LENGTH) markChunkEmbedded(c.id)
}
console.log(`re-embedding: ${toEmbed.length}`)
const embedder = createRemoteEmbedder(emb)
for (let i = 0; i < toEmbed.length; i += 100) {
  const batch = toEmbed.slice(i, i + 100)
  const vectors = await embedder.embed(batch.map((c) => c.text))
  addVectors(
    batch.map((c, j) => {
      const vec = vectors[j]
      if (!vec) throw new Error(`missing vector for ${c.id}`)
      return { chunkId: c.id, vector: vec, modelId: emb.modelId }
    }),
  )
  for (const c of batch) markChunkEmbedded(c.id)
  console.log(`embedded ${Math.min(i + 100, toEmbed.length)}/${toEmbed.length}`)
}
console.log('done')
