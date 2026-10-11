/**
 * 知识库统一检索入口
 * Ported from patentExaminator routes/knowledge.ts knowledgeSearch pipeline.
 *
 * 流程：query embed → cosine 相似度初筛 → BM25+向量 RRF 混合 → 重排 → parent 文本注入。
 * 已知偏差：query expansion (hyde/queryExpand.ts) 未移植 —— 属于上层编排功能，
 * 与知识库检索 API 本身解耦。
 */

import type { ChunkMetadata, KnowledgeSearchHit } from '../../shared/knowledge'
import { getAllChunks, getAllVectors, getChunksWithParent } from './db'
import { createRemoteEmbedder } from './embed'
import { hybridSearch } from './bm25'
import { rerankCandidates } from './rerank'
import { embedderConfig, rerankProviderConfig, type EmbedderConfig } from './settings'

const TOP_K = 15
const RELATIVE_THRESHOLD = 0.7
const SCORE_FLOOR = 0.1

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0)
    normA += (a[i] ?? 0) ** 2
    normB += (b[i] ?? 0) ** 2
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
}

export interface KnowledgeSearchOptions {
  topK?: number
  useRerank?: boolean
  sourceIds?: string[]
}

/** 知识库检索主入口：embed → cosine → hybrid → rerank → hits */
export async function knowledgeSearch(
  query: string,
  config: EmbedderConfig,
  options: KnowledgeSearchOptions = {},
): Promise<KnowledgeSearchHit[]> {
  const topK = options.topK ?? TOP_K
  const embedder = createRemoteEmbedder(config)

  // 1. query → vector
  console.info(`[knowledge] [Search] [Step 1] Embedding query: "${query.slice(0, 50)}..." model=${config.modelId}`)
  const [queryVec] = await embedder.embed([query])
  if (!queryVec) throw new Error('Embedding API returned no vector for query')

  // 2. cosine 相似度（相对阈值 + 下限双闸门）
  // 全量余弦分留一份 map：RRF 融合后只剩名次分数（~1/(60+rank)，不是相似度），
  // 重排还必须拿得到真实余弦分（见下面 candidates 处）。
  const vectors = getAllVectors()
  const cosineAll = vectors.map((v) => ({ chunkId: v.chunkId, score: cosineSimilarity(queryVec, v.vector) }))
  const cosineByChunk = new Map(cosineAll.map((s) => [s.chunkId, s.score]))
  const scored = cosineAll.filter((s) => s.score >= SCORE_FLOOR)

  const maxScore = scored.length > 0 ? Math.max(...scored.map((s) => s.score)) : 0
  const threshold = Math.max(SCORE_FLOOR, maxScore * RELATIVE_THRESHOLD)
  const candidateScores = scored.filter((s) => s.score >= threshold)
  console.info(`[knowledge] [Search] [Step 1] Vector search: ${vectors.length} 全部 → ${candidateScores.length} 结果 (top=${maxScore.toFixed(4)})`)

  // 3. BM25 + 向量 RRF 混合
  const fused = hybridSearch(query, candidateScores, topK * 3)
  if (fused.length === 0) return []

  // 4. 重排（远程 API → 本地启发式降级）
  const chunks = getAllChunks()
  const chunkMap = new Map(chunks.map((c) => [c.id, c]))
  let candidates = fused
    .filter((f) => chunkMap.has(f.chunkId))
    .filter((f) => !options.sourceIds || options.sourceIds.length === 0 || options.sourceIds.includes(chunkMap.get(f.chunkId)!.sourceId))
    .map((f) => {
      const chunk = chunkMap.get(f.chunkId)!
      let metadata: Record<string, unknown> = {}
      try {
        metadata = JSON.parse(chunk.metadata) as Record<string, unknown>
      } catch {
        metadata = {}
      }
      // 回填真实余弦分。RRF 融合只保留名次（分数 ~1/(60+rank)），而本地重排把
      // candidate.score 当作「语义相似度」信号（权重 0.3–0.4）——直接传 RRF 分会把
      // 语义信号清零，重排退化成关键词/文档类型/条号启发式：查询词面越像的错误文档
      // 分越高，真正相关的条文反而被压下去（实测假司法解释 top 0.96、真法条 0.28）。
      // 向量闸门筛掉的 chunk 若只经 BM25 进来，余弦分照查（真实值，通常很低）。
      return { chunkId: f.chunkId, text: chunk.text, metadata, score: cosineByChunk.get(f.chunkId) ?? f.score }
    })

  if (candidates.length === 0) return []

  const rerankConfig = options.useRerank === false ? null : rerankProviderConfig()
  console.info(`[knowledge] [Search] [Step 3] Rerank 候选: ${candidates.length} 条`)
  const reranked = await rerankCandidates(candidates, query, rerankConfig, topK)
  console.info(`[knowledge] [Search] [Step 4] Rerank 完成: ${reranked.length} 结果`)

  // 5. parent 文本注入（Parent-Child 模式）
  const parentInfo = getChunksWithParent(reranked.map((r) => r.chunkId))

  return reranked.slice(0, topK).map((r) => {
    const chunk = chunkMap.get(r.chunkId)!
    const info = parentInfo.get(r.chunkId)
    let metadata: Record<string, unknown> = {}
    try {
      metadata = JSON.parse(chunk.metadata) as Record<string, unknown>
    } catch {
      metadata = {}
    }
    return {
      chunkId: r.chunkId,
      text: info?.parentText ?? chunk.text,
      score: r.score,
      metadata: {
        ...(metadata as ChunkMetadata),
        sourceId: chunk.sourceId,
      },
    }
  })
}
