/**
 * 服务端重排序器 — 使用多信号评分对检索结果重新排序
 * Ported from patentExaminator server/src/lib/reranker.ts + the remote rerank
 * request in routes/knowledge.ts.
 *
 * cr-2 降级链（本项目）：远程 Reranker API（BAAI/bge-reranker-v2-m3）→ 本地启发式算法。
 * （本地 Cross-Encoder 层依赖 @xenova/transformers，本项目不引入。）
 * 5 个信号加权：语义相似度、关键词匹配、文档类型、法条引用、chunk 深度
 */

export interface RerankConfig {
  semanticWeight: number
  keywordWeight: number
  categoryWeight: number
  articleRefWeight: number
  depthWeight: number
}

const DEFAULT_CONFIG: RerankConfig = {
  semanticWeight: 0.4,
  keywordWeight: 0.25,
  categoryWeight: 0.15,
  articleRefWeight: 0.15,
  depthWeight: 0.05,
}

/** 法律文本专用权重：法条引用匹配权重更高 */
const LEGAL_CONFIG: RerankConfig = {
  semanticWeight: 0.3,
  keywordWeight: 0.2,
  categoryWeight: 0.15,
  articleRefWeight: 0.3, // 法律文本中，法条引用匹配更重要
  depthWeight: 0.05,
}

const CATEGORY_WEIGHTS: Record<string, number> = {
  法律: 1.0,
  行政法规: 0.9,
  司法解释: 0.85,
  审查指南: 0.95,
  案例: 0.7,
  其他: 0.5,
}

export interface RerankCandidate {
  chunkId: string
  text: string
  metadata: Record<string, unknown>
  score: number
}

export interface RerankOutput {
  chunkId: string
  score: number
}

/** 远程 re-ranker API 连接参数（SiliconFlow 等） */
export interface RerankProviderConfig {
  baseUrl: string
  apiKey: string
  modelId: string
}

/** 根据文档类型获取 reranking 配置 */
function getRerankConfig(metadata: Record<string, unknown>): RerankConfig {
  const category = (metadata['documentCategory'] as string) ?? '其他'
  if (['法律', '行政法规', '司法解释'].includes(category)) {
    return LEGAL_CONFIG
  }
  return DEFAULT_CONFIG
}

/** 提取文本中的关键词（去停用词） */
function extractTerms(text: string): string[] {
  const stopWords = new Set([
    '的', '了', '是', '在', '和', '有', '不', '这', '我', '他', '她', '它',
    '们', '那', '被', '从', '到', '也', '就', '都', '而', '及', '与', '或',
    '但', '如', '所', '之', '等', '将', '已', '可', '对', '于', '其', '上',
    '下', '中', '为', '以', '因', '并', '地', '要', '会', '能', '来', '去',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'to', 'of', 'in', 'for', 'on', 'with',
    'at', 'by', 'from', 'as', 'into', 'through', 'during', 'before', 'after',
  ])

  const tokens: string[] = []
  const chineseChars = text.match(/[一-鿿]{2,}/g) ?? []
  const englishWords = text.match(/[a-zA-Z]{3,}/g) ?? []
  tokens.push(...chineseChars, ...englishWords.map((w) => w.toLowerCase()))

  return [...new Set(tokens.filter((t) => !stopWords.has(t) && t.length >= 2))]
}

/** 对检索结果进行本地重排序（启发式 5 信号） */
export function localRerank(results: RerankCandidate[], query: string, config?: RerankConfig): RerankOutput[] {
  if (results.length <= 1) {
    return results.map((r) => ({ chunkId: r.chunkId, score: r.score }))
  }

  // 如果未指定配置，根据文档元数据自动选择
  const effectiveConfig = config ?? (results[0]?.metadata ? getRerankConfig(results[0].metadata) : DEFAULT_CONFIG)
  const queryTerms = extractTerms(query)

  const scored = results.map((result) => {
    const { chunkId, text, metadata, score: semanticScore } = result

    // 1. 原始相似度分数
    const s1 = semanticScore

    // 2. 关键词匹配度
    const chunkTerms = extractTerms(text)
    const matchedTerms = queryTerms.filter((t) => chunkTerms.includes(t))
    const s2 = queryTerms.length > 0 ? matchedTerms.length / queryTerms.length : 0

    // 3. 文档类型权重
    const category = (metadata['documentCategory'] as string) ?? '其他'
    const s3 = CATEGORY_WEIGHTS[category] ?? 0.5

    // 4. 法条引用匹配度
    const articleRefs = (metadata['articleRefs'] as string[]) ?? []
    const matchedRefs = articleRefs.filter((ref) => queryTerms.some((t) => ref.includes(t) || t.includes(ref)))
    const s4 = articleRefs.length > 0 ? matchedRefs.length / articleRefs.length : 0

    // 5. 深度权重（depth 0 = 最权威）
    const depth = (metadata['depth'] as number) ?? 2
    const s5 = 1 - Math.min(depth / 3, 1)

    // 综合评分
    const finalScore =
      s1 * effectiveConfig.semanticWeight +
      s2 * effectiveConfig.keywordWeight +
      s3 * effectiveConfig.categoryWeight +
      s4 * effectiveConfig.articleRefWeight +
      s5 * effectiveConfig.depthWeight

    return { chunkId, score: finalScore }
  })

  return scored.sort((a, b) => b.score - a.score)
}

function rerankEndpoint(baseUrl: string): string {
  const base = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl.replace(/\/$/, '')}/v1`
  return `${base}/rerank`
}

/**
 * 远程 re-ranker API（SiliconFlow /v1/rerank, BAAI/bge-reranker-v2-m3）。
 * 失败时抛错，由调用方降级到 localRerank。
 */
export async function remoteRerank(
  candidates: RerankCandidate[],
  query: string,
  config: RerankProviderConfig,
  topK: number,
): Promise<RerankOutput[]> {
  const response = await fetch(rerankEndpoint(config.baseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.modelId,
      query,
      documents: candidates.map((c) => c.text.slice(0, 2000)),
      top_n: topK,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    throw new Error(`Remote reranker API error: ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as { results?: Array<{ index: number; relevance_score?: number }> }
  const results = data.results ?? []
  return results
    .filter((r) => typeof r.index === 'number' && r.index >= 0 && r.index < candidates.length)
    .map((r) => ({ chunkId: candidates[r.index as number]!.chunkId, score: r.relevance_score ?? 0 }))
}

/** 重排入口：远程 API → 本地启发式（失败自动降级） */
export async function rerankCandidates(
  candidates: RerankCandidate[],
  query: string,
  config: RerankProviderConfig | null,
  topK: number,
): Promise<RerankOutput[]> {
  if (candidates.length === 0) return []
  if (config) {
    try {
      const remote = await remoteRerank(candidates, query, config, topK)
      if (remote.length > 0) return remote
    } catch (err) {
      console.error(`[knowledge] Remote rerank failed, falling back to local: ${String(err)}`)
    }
  }
  return localRerank(candidates, query)
}
