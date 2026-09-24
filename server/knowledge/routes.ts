/**
 * 知识库 / 检索设置 / 联网检索 HTTP 路由（stdlib http，无 express）
 * Ports the patentExaminator endpoints:
 *   routes/knowledge.ts  → /api/knowledge/*  (+ /api/retrieval settings)
 *   routes/search.ts     → /api/search-references, /api/verify-search-key
 * Settings persist via server/knowledge/settings.ts (key-merge patches,
 * masked views); files upload as raw bytes in the request body.
 */

import crypto from 'node:crypto'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { PRESET_KNOWLEDGE_PROVIDERS, KNOWLEDGE_UPLOAD_STEPS, MIN_EMBED_LENGTH, type KnowledgeSource } from '../../shared/knowledge'
import type { LegalChunkMetadata } from './chunker'
import { PRESET_SEARCH_PROVIDERS, type SearchProviderId } from '../../shared/search'
import {
  retrievalSettingsView,
  putRetrievalSettings,
  embedderConfig,
  activeSearchProvider,
  searchProviderRow,
  type RetrievalSettingsPatch,
} from './settings'
import { getAllSources, deleteSource, getStats, getChunksBySourceId, clearAll } from './db'
import { extractText, extractFromUrl } from './extract'
import { chunkByDocumentType } from './chunker'
import { classifyDocument, isNoise, isGarbled, preprocessText } from './preprocess'
import { computeTextHash, findChunksByHashes, addChunks, addSource, addVectors, markChunkEmbedded, markSourceEmbedStatus } from './db'
import { createRemoteEmbedder } from './embed'
import { invalidateBM25Index } from './bm25'
import { knowledgeSearch } from './search'
import { testEmbeddingProvider } from './embed'
import { remoteRerank } from './rerank'
import { searchPatents } from '../search/webSearch'
import { validateExternalUrl, validateProviderBaseUrls, BlockedUrlError } from '../urlValidation'

const FETCH_TIMEOUT_MS = 30_000

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(s)
}

function readBody(req: IncomingMessage, limit = 110_000_000): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    let n = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > limit) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** 文件级 hash（与源项目一致：sha256(file bytes)） */
function fileHashOf(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

// ── 通用上传管线（文件 / URL 共用；SSE 5 步进度） ──────────

interface IngestChunk {
  id: string
  sourceId: string
  index: number
  text: string
  strategy: string
  metadata: Record<string, unknown>
  parentId?: string
}

function filterChunks(
  chunks: Array<{ text: string; metadata: Record<string, unknown> | LegalChunkMetadata; parentId?: string }>,
): Array<{ text: string; metadata: Record<string, unknown>; parentId?: string }> {
  const dedupHashes = new Set<string>()
  const filtered: Array<{ text: string; metadata: Record<string, unknown>; parentId?: string }> = []
  for (const rc of chunks) {
    if (isNoise(rc.text) || isGarbled(rc.text)) continue
    const hash = crypto.createHash('sha256').update(rc.text.replace(/[\s　]/g, '').toLowerCase()).digest('hex')
    if (dedupHashes.has(hash)) continue
    dedupHashes.add(hash)
    const entry: { text: string; metadata: Record<string, unknown>; parentId?: string } = {
      text: rc.text,
      metadata: rc.metadata as Record<string, unknown>,
    }
    if (rc.parentId) entry.parentId = rc.parentId
    filtered.push(entry)
  }
  return filtered
}

/** 存 chunk + 断点续传 + 批量向量化（cr-1 远程 API / 无配置则纯 BM25） */
async function embedAndStore(
  sourceId: string,
  filtered: Array<{ text: string; metadata: Record<string, unknown>; parentId?: string }>,
  sendEvent: (data: Record<string, unknown>) => void,
): Promise<IngestChunk[]> {
  const chunks: IngestChunk[] = filtered.map((rc, i) => {
    const chunk: IngestChunk = {
      id: `${sourceId}-c${i}`,
      sourceId,
      index: i,
      text: rc.text,
      strategy: 'auto',
      metadata: rc.metadata,
    }
    if (rc.parentId) chunk.parentId = `${sourceId}-${rc.parentId}`
    return chunk
  })
  addChunks(chunks)

  const emb = embedderConfig()
  if (chunks.length > 0 && emb) {
    // 断点续传：跳过已有 embedding 的 chunk
    const chunkHashes = chunks.map((c) => computeTextHash(c.text))
    const existingEmbeddings = findChunksByHashes(chunkHashes)
    const chunksToEmbed: IngestChunk[] = []
    let skippedCount = 0
    for (let i = 0; i < chunks.length; i++) {
      const hash = chunkHashes[i]
      const chunk = chunks[i]
      if (!hash || !chunk) continue
      const existing = existingEmbeddings.get(hash)
      if (existing) {
        addVectors([{ chunkId: chunk.id, vector: existing.vector, modelId: emb.modelId }])
        markChunkEmbedded(chunk.id)
        skippedCount++
      } else {
        chunksToEmbed.push(chunk)
      }
    }
    if (skippedCount > 0) {
      console.info(`[knowledge] [Embedding] 断点续传：跳过 ${skippedCount} 个已有 embedding 的 chunk`)
      sendEvent({ step: 'embedding', stepNum: 5, totalSteps: KNOWLEDGE_UPLOAD_STEPS, message: `断点续传跳过 ${skippedCount} 条，剩余 ${chunksToEmbed.length} 条需向量化`, total: chunks.length, skipped: skippedCount })
    }

    // 过滤过短 chunk（<MIN_EMBED_LENGTH 字）
    const validChunks = chunksToEmbed.filter((c) => c.text.length >= MIN_EMBED_LENGTH)
    const shortChunkCount = chunksToEmbed.length - validChunks.length
    if (shortChunkCount > 0) {
      console.info(`[knowledge] [Embedding] 过滤 ${shortChunkCount} 个过短 chunk（<${MIN_EMBED_LENGTH} 字）`)
      for (const chunk of chunksToEmbed) {
        if (chunk.text.length < MIN_EMBED_LENGTH) markChunkEmbedded(chunk.id)
      }
    }

    // 大 batch + 长度排序（短文本优先填满 batch）
    const BATCH_SIZE = 100
    const sortedChunks = [...validChunks].sort((a, b) => a.text.length - b.text.length)
    const embedder = createRemoteEmbedder(emb)
    for (let i = 0; i < sortedChunks.length; i += BATCH_SIZE) {
      const batch = sortedChunks.slice(i, i + BATCH_SIZE)
      const texts = batch.map((c) => c.text)
      const vectors = await embedder.embed(texts)
      const vectorRecords = batch.map((c, j) => {
        const vec = vectors[j]
        if (!vec) throw new Error(`Missing vector for chunk ${c.id} at index ${j}`)
        return { chunkId: c.id, vector: vec, modelId: emb.modelId }
      })
      addVectors(vectorRecords)
      for (const chunk of batch) markChunkEmbedded(chunk.id)
      sendEvent({
        step: 'embedding',
        stepNum: 5,
        totalSteps: KNOWLEDGE_UPLOAD_STEPS,
        progress: Math.min(i + BATCH_SIZE, sortedChunks.length),
        total: sortedChunks.length,
        skipped: skippedCount,
        filtered: shortChunkCount,
      })
    }
  } else if (chunks.length > 0) {
    // 未配置远程 embedding API：仅存储 chunk（BM25 关键词检索可用）
    console.info(`[knowledge] [Embedding] 未配置远程 embedding API，跳过向量化，仅存储 ${chunks.length} 条知识`)
    sendEvent({ step: 'embedding', stepNum: 5, totalSteps: KNOWLEDGE_UPLOAD_STEPS, message: '未配置 Embedding API，仅存储文本（可通过 BM25 关键词检索）', total: chunks.length, skipped: chunks.length })
    for (const chunk of chunks) markChunkEmbedded(chunk.id)
  }

  return chunks
}

function startSse(res: ServerResponse): (data: Record<string, unknown>) => void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  return (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
}

// ── 路由入口 ─────────────────────────────────────────

export async function handleRetrievalRoute(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  method: string | undefined,
): Promise<boolean> {
  // GET /api/retrieval/settings — masked view (B-041: raw keys never leave server)
  if (p === '/api/retrieval/settings' && method !== 'PUT' && method !== 'POST') {
    json(res, 200, { ok: true, settings: retrievalSettingsView() })
    return true
  }

  // PUT /api/retrieval/settings — key-merge patch
  if (p === '/api/retrieval/settings' && method === 'PUT') {
    const raw = await readBody(req)
    try {
      const patch = JSON.parse(raw.toString('utf8')) as RetrievalSettingsPatch
      putRetrievalSettings(patch)
      json(res, 200, { ok: true, settings: retrievalSettingsView() })
    } catch (err) {
      json(res, 400, { ok: false, error: errMsg(err) })
    }
    return true
  }

  // POST /api/knowledge/providers/test — test embedding / reranker connection
  if (p === '/api/knowledge/providers/test' && method === 'POST') {
    const raw = await readBody(req)
    try {
      const body = JSON.parse(raw.toString('utf8')) as {
        providerType?: string
        baseUrl?: string
        apiKey?: string
        modelId?: string
      }
      const { providerType, baseUrl, apiKey, modelId } = body
      if (!baseUrl || !apiKey || !modelId) {
        json(res, 400, { ok: false, error: 'baseUrl, apiKey and modelId are required' })
        return true
      }
      if (providerType === 'embedding') {
        const result = await testEmbeddingProvider({ baseUrl, apiKey, modelId })
        if (!result.ok) console.error(`[knowledge] Knowledge provider test error (embedding): ${result.error ?? ''}`)
        json(res, 200, result)
      } else if (providerType === 'reranker') {
        try {
          const probe = await remoteRerank(
            [{ chunkId: 't0', text: 'test document', metadata: {}, score: 0 }],
            'test',
            { baseUrl, apiKey, modelId },
            1,
          )
          if (probe.length === 0) json(res, 200, { ok: false, error: '响应格式异常: 缺少 rerank 结果' })
          else json(res, 200, { ok: true })
        } catch (err) {
          console.error(`[knowledge] Knowledge provider test error (reranker): ${errMsg(err)}`)
          json(res, 200, { ok: false, error: errMsg(err).slice(0, 300) })
        }
      } else {
        json(res, 400, { ok: false, error: `Unknown provider type: ${providerType ?? ''}` })
      }
    } catch (err) {
      console.error(`[knowledge] Knowledge provider test error: ${errMsg(err)}`)
      json(res, 400, { ok: false, error: errMsg(err) })
    }
    return true
  }

  // POST /api/knowledge/upload — raw file bytes in body, ?name= filename.
  // SSE 5-step progress; file-level dedupe by sha256.
  if (p === '/api/knowledge/upload' && method === 'POST') {
    const fileName = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? 'upload.txt')
    const sendEvent = startSse(res)
    try {
      const body = await readBody(req)
      if (body.length === 0) {
        sendEvent({ step: 'error', error: 'No file provided' })
        res.end()
        return true
      }

      const hash = fileHashOf(body)
      const { findDuplicateByHash } = await import('./db')
      const existing = findDuplicateByHash(hash)
      if (existing) {
        sendEvent({ step: 'done', skipped: true, message: `已存在: ${existing.name}` })
        res.end()
        return true
      }

      const sourceId = `ks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

      // Step 1/5: 提取文本
      sendEvent({ step: 'extracting', stepNum: 1, totalSteps: KNOWLEDGE_UPLOAD_STEPS, message: `提取 ${fileName} 文本...` })
      const extraction = await extractText(body, fileName)
      sendEvent({ step: 'extracting', stepNum: 1, totalSteps: KNOWLEDGE_UPLOAD_STEPS, done: true, chars: extraction.text.length })

      // Step 2/5: 预处理
      sendEvent({ step: 'preprocessing', stepNum: 2, totalSteps: KNOWLEDGE_UPLOAD_STEPS, message: '文本清洗与规范化...' })
      const cleanedText = preprocessText(extraction.text)
      console.info(`[knowledge] [${fileName}] 预处理: ${extraction.text.length} → ${cleanedText.length} 字符`)
      sendEvent({ step: 'preprocessing', stepNum: 2, totalSteps: KNOWLEDGE_UPLOAD_STEPS, done: true })

      // Step 3/5: 切片
      sendEvent({ step: 'chunking', stepNum: 3, totalSteps: KNOWLEDGE_UPLOAD_STEPS, message: '切片处理中...' })
      const docCategory = classifyDocument(fileName, cleanedText)
      const legalChunks = chunkByDocumentType(cleanedText, docCategory, { fileName, documentCategory: docCategory })
      const filtered = filterChunks(legalChunks)
      console.info(`[knowledge] [${fileName}] 文档分类: ${docCategory} | 切片: ${legalChunks.length} → ${filtered.length} 条`)
      sendEvent({ step: 'chunking', stepNum: 3, totalSteps: KNOWLEDGE_UPLOAD_STEPS, done: true, total: filtered.length })

      // Step 4/5: 存储
      addSource({
        id: sourceId,
        name: fileName,
        type: 'file',
        format: fileName.toLowerCase().split('.').pop() ?? 'txt',
        mediaType: extraction.mediaType,
        size: body.length,
        fileHash: hash,
        chunkCount: filtered.length,
        embedStatus: 'processing',
      })
      const chunks = await embedAndStore(sourceId, filtered, sendEvent).catch((err) => {
        // Source behavior: chunks stay persisted + source marked failed; SSE reports the error
        console.error(`[knowledge] Knowledge upload error: ${fileName}: ${errMsg(err)}`)
        sendEvent({ step: 'error', error: errMsg(err) })
        res.end()
        return [] as IngestChunk[]
      })
      if (chunks.length === 0) return true

      invalidateBM25Index()
      markSourceEmbedStatus(sourceId, 'done')
      console.info(`[knowledge] Uploaded ${fileName}: ${chunks.length} chunks${embedderConfig() ? ' embedded' : ' (no embedding, BM25 only)'}`)
      sendEvent({ step: 'done', ok: true, sourceId, fileName, chunkCount: chunks.length, message: `✅ ${fileName} — ${chunks.length} 条知识已入库` })
      res.end()
    } catch (err) {
      console.error(`[knowledge] Knowledge upload error: ${errMsg(err)}`)
      sendEvent({ step: 'error', error: errMsg(err) })
      res.end()
    }
    return true
  }

  // POST /api/knowledge/import-url — { url } JSON body
  if (p === '/api/knowledge/import-url' && method === 'POST') {
    const raw = await readBody(req)
    try {
      const { url } = JSON.parse(raw.toString('utf8')) as { url?: string }
      if (!url) {
        json(res, 400, { ok: false, error: 'url is required' })
        return true
      }
      try {
        validateExternalUrl(url)
      } catch (err) {
        if (err instanceof BlockedUrlError) {
          json(res, 400, { ok: false, error: (err as Error).message })
          return true
        }
        throw err
      }

      const sourceId = `ks-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const extraction = await extractFromUrl(url)
      const cleanedText = preprocessText(extraction.text)
      console.info(`[knowledge] [URL:${url}] 预处理: ${extraction.text.length} → ${cleanedText.length} 字符`)
      const docCategory = classifyDocument(url, cleanedText)
      const legalChunks = chunkByDocumentType(cleanedText, docCategory, { fileName: url, documentCategory: docCategory })
      const filtered = filterChunks(legalChunks)
      console.info(`[knowledge] [URL:${url}] 文档分类: ${docCategory} | 切片: ${legalChunks.length} → ${filtered.length} 条`)

      addSource({
        id: sourceId,
        name: url,
        type: 'url',
        format: extraction.mediaType === 'text' ? 'html' : 'pdf',
        mediaType: extraction.mediaType,
        size: extraction.text.length,
        sourceUrl: url,
        chunkCount: filtered.length,
        embedStatus: 'processing',
      })
      const chunks = await embedAndStore(
        sourceId,
        filtered,
        () => {
          /* non-SSE import: progress not streamed */
        },
      ).catch((err) => {
        markSourceEmbedStatus(sourceId, 'failed')
        throw err
      })

      invalidateBM25Index()
      markSourceEmbedStatus(sourceId, 'done')
      console.info(`[knowledge] Uploaded URL ${url}: ${chunks.length} chunks`)
      json(res, 200, { ok: true, sourceId, chunkCount: chunks.length, message: `✅ ${url} — ${chunks.length} 条知识已入库` })
    } catch (err) {
      console.error(`[knowledge] Knowledge URL import error: ${errMsg(err)}`)
      json(res, 500, { ok: false, error: errMsg(err) })
    }
    return true
  }

  // GET /api/knowledge/sources — list
  if (p === '/api/knowledge/sources' && method !== 'DELETE' && method !== 'POST') {
    const sources: KnowledgeSource[] = getAllSources().map((s) => ({
      id: s.id,
      name: s.name,
      type: s.type as KnowledgeSource['type'],
      format: s.format as KnowledgeSource['format'],
      mediaType: s.mediaType as KnowledgeSource['mediaType'],
      size: s.size,
      chunkCount: s.chunkCount,
      embedStatus: s.embedStatus as KnowledgeSource['embedStatus'],
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      fileHash: s.fileHash,
      sourceUrl: s.sourceUrl,
    }))
    json(res, 200, { ok: true, sources })
    return true
  }

  // GET /api/knowledge/sources/:id/chunks
  const chunksMatch = p.match(/^\/api\/knowledge\/sources\/([^/]+)\/chunks$/)
  if (chunksMatch && method !== 'POST') {
    const id = decodeURIComponent(chunksMatch[1] ?? '')
    const limit = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit') ?? 20)
    const chunks = getChunksBySourceId(id, Number.isFinite(limit) ? limit : 20).map((c) => ({
      ...c,
      metadata: (() => {
        try {
          return JSON.parse(c.metadata) as Record<string, unknown>
        } catch {
          return {}
        }
      })(),
    }))
    json(res, 200, { ok: true, chunks })
    return true
  }

  // DELETE /api/knowledge/sources/:id
  const delMatch = p.match(/^\/api\/knowledge\/sources\/([^/]+)$/)
  if (delMatch && method === 'DELETE') {
    try {
      deleteSource(decodeURIComponent(delMatch[1] ?? ''))
      invalidateBM25Index()
      json(res, 200, { ok: true })
    } catch (err) {
      json(res, 500, { ok: false, error: errMsg(err) })
    }
    return true
  }

  // GET /api/knowledge/stats
  if (p === '/api/knowledge/stats') {
    json(res, 200, { ok: true, ...getStats() })
    return true
  }

  // DELETE /api/knowledge/clear
  if (p === '/api/knowledge/clear' && method === 'DELETE') {
    try {
      clearAll()
      invalidateBM25Index()
      json(res, 200, { ok: true })
    } catch (err) {
      json(res, 500, { ok: false, error: errMsg(err) })
    }
    return true
  }

  // POST /api/knowledge/search
  if (p === '/api/knowledge/search' && method === 'POST') {
    const raw = await readBody(req)
    try {
      const body = JSON.parse(raw.toString('utf8')) as { query?: string; topK?: number; useRerank?: boolean; sourceIds?: string[] }
      if (!body.query || typeof body.query !== 'string') {
        json(res, 400, { ok: false, error: 'query is required' })
        return true
      }
      const config = embedderConfig()
      if (!config) {
        json(res, 503, { ok: false, error: '未配置 Embedding API，无法执行向量检索（BM25 关键词检索不受影响）。' })
        return true
      }
      const results = await knowledgeSearch(body.query, config, {
        topK: body.topK,
        useRerank: body.useRerank,
        sourceIds: body.sourceIds,
      })
      console.info(`[knowledge] [Search] query="${body.query.slice(0, 50)}..." model=${config.modelId} → ${results.length} 结果`)
      json(res, 200, { ok: true, results })
    } catch (err) {
      console.error(`[knowledge] Knowledge search error: ${errMsg(err)}`)
      json(res, 500, { ok: false, error: errMsg(err) })
    }
    return true
  }

  return false
}

// ── 联网检索（Search API）─────────────────────────────

const NO_KEY_MESSAGE = '搜索服务不可用：未配置搜索 API Key。请在设置→专利搜索中配置，或手动上传文献。'

/** 从 feature 描述构造检索 query（确定性；源项目由 LLM 生成，此处为已知降级） */
function featureQueries(claimText: string, features: Array<{ featureCode: string; description: string }>): string[] {
  const base = claimText.trim()
  const queries = features
    .map((f) => f.description.trim())
    .filter((d) => d.length > 0)
    .map((d) => (base ? `${base} ${d}` : d))
  if (queries.length === 0 && base) queries.push(base)
  return queries
}

export async function handleSearchApiRoute(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  method: string | undefined,
): Promise<boolean> {
  // POST /api/search-references
  if (p === '/api/search-references' && method === 'POST') {
    const raw = await readBody(req)
    try {
      const body = JSON.parse(raw.toString('utf8')) as {
        claimText?: string
        features?: Array<{ featureCode: string; description: string }>
        maxResults?: number
        searchProviderId?: SearchProviderId
        searchBaseUrl?: string
        searchApiKey?: string
      }
      if (typeof body.claimText !== 'string' || !Array.isArray(body.features)) {
        json(res, 400, { ok: false, candidates: [], error: 'Invalid request: claimText and features are required' })
        return true
      }

      // SSRF protection: validate user-provided URLs
      if (body.searchBaseUrl) validateExternalUrl(body.searchBaseUrl)

      // Resolve key: request body first (test mode), then stored settings (APP mode)
      const stored = activeSearchProvider()
      const providerId = body.searchProviderId ?? stored?.providerId ?? 'tavily'
      const apiKey = body.searchApiKey ?? stored?.apiKey
      const baseUrl = body.searchBaseUrl ?? stored?.baseUrl
      if (!apiKey) {
        json(res, 503, { ok: false, candidates: [], error: NO_KEY_MESSAGE })
        return true
      }

      const queries = featureQueries(body.claimText, body.features)
      const maxResults = body.maxResults ?? 10
      console.info(`[search] Search provider provider=${providerId} queries=${queries.length}`)
      const response = await searchPatents(queries, maxResults, {
        providerId,
        apiKey,
        ...(baseUrl ? { baseUrl } : {}),
      })
      const candidates = response.results.map((r, i) => ({
        rank: i + 1,
        title: r.title,
        url: r.url,
        snippet: r.content,
        score: r.score,
      }))
      console.info(`[search] Search returned provider=${providerId} count=${candidates.length}`)
      json(res, 200, { ok: true, candidates, query: response.query })
    } catch (err) {
      const message = err instanceof BlockedUrlError ? err.message : errMsg(err)
      console.error(`[search] Search references error: ${message}`)
      json(res, 500, { ok: false, candidates: [], error: message })
    }
    return true
  }

  // GET /api/search/providers — preset list for the settings screen
  if (p === '/api/search/providers') {
    json(res, 200, { ok: true, providers: PRESET_SEARCH_PROVIDERS })
    return true
  }

  // POST /api/verify-search-key — probe each provider with a 1-result test query
  if (p === '/api/verify-search-key' && method === 'POST') {
    const raw = await readBody(req)
    const body = JSON.parse(raw.toString('utf8') || '{}') as {
      providerId?: SearchProviderId
      apiKey?: string
      baseUrl?: string
      /** 未提供 apiKey 时，测试设置里已存的 key */
      useStoredKey?: boolean
    }
    const providerId = body.providerId
    if (!providerId) {
      json(res, 400, { ok: false, error: 'Invalid request' })
      return true
    }
    const storedRow = body.useStoredKey && !body.apiKey ? searchProviderRow(providerId) : undefined
    const apiKey = body.apiKey ?? storedRow?.apiKeyRef ?? ''
    const baseUrl = body.baseUrl ?? storedRow?.baseUrl
    if (!apiKey) {
      json(res, 400, { ok: false, providerId, error: 'apiKey is required' })
      return true
    }

    try {
      if (baseUrl) validateExternalUrl(baseUrl)
      let ok = false
      let message = ''
      let error = ''
      if (providerId === 'tavily') {
        const response = await fetch('https://api.tavily.com/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ api_key: apiKey, query: 'test', max_results: 1, include_answer: false }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        ok = response.ok
        if (ok) message = 'Tavily API Key 有效'
        else error = `Key 无效 (${response.status}): ${(await response.text().catch(() => '')).slice(0, 100)}`
      } else if (providerId === 'serpapi') {
        const url = new URL('https://serpapi.com/search')
        url.searchParams.set('engine', 'google')
        url.searchParams.set('q', 'test')
        url.searchParams.set('num', '1')
        url.searchParams.set('api_key', apiKey)
        const response = await fetch(url.toString(), {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        ok = response.ok
        if (ok) message = 'SerpAPI Key 有效'
        else error = `Key 无效 (${response.status}): ${(await response.text().catch(() => '')).slice(0, 100)}`
      } else if (providerId === 'epo') {
        const colonIdx = apiKey.indexOf(':')
        if (colonIdx === -1) {
          json(res, 200, { ok: false, providerId, error: 'EPO OPS 需要 Consumer Key:Consumer Secret 格式' })
          return true
        }
        const credentials = Buffer.from(apiKey).toString('base64')
        const response = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
          method: 'POST',
          headers: { Authorization: `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        ok = response.ok
        if (ok) message = 'EPO OPS Consumer Key/Secret 有效'
        else error = `EPO 认证失败 (${response.status}): ${(await response.text().catch(() => '')).slice(0, 100)}`
      } else if (providerId === 'serper') {
        const endpoint = (baseUrl || 'https://google.serper.dev') + '/search'
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-API-KEY': apiKey },
          body: JSON.stringify({ q: 'test', num: 1 }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        ok = response.ok
        if (ok) message = 'Serper.dev API Key 有效'
        else error = `Key 无效 (${response.status}): ${(await response.text().catch(() => '')).slice(0, 100)}`
      } else if (providerId === 'custom' && baseUrl) {
        const url = new URL(baseUrl)
        url.searchParams.set('q', 'test')
        url.searchParams.set('max_results', '1')
        const response = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        ok = response.ok
        if (ok) message = '自定义搜索 API Key 有效'
        else error = `Key 无效 (${response.status})`
      } else {
        json(res, 400, { ok: false, error: '自定义搜索需要提供 API 端点' })
        return true
      }
      if (ok) json(res, 200, { ok: true, providerId, message })
      else {
        console.error(`[search] Verify search key failed provider=${providerId}: ${error}`)
        json(res, 200, { ok: false, providerId, error })
      }
    } catch (err) {
      const message = err instanceof BlockedUrlError ? err.message : '验证失败，请稍后重试'
      console.error(`[search] Verify search key error provider=${providerId}: ${message}`)
      json(res, 200, { ok: false, providerId, error: message })
    }
    return true
  }

  return false
}
