// 本地 patent-law-mcp（设计 §12）：把 M0 的专利法知识库 RAG 包装成 agent
// 可调用的权威法源 MCP。v1 为 runner 同进程的 MCP 工具注册表（无新依赖；
// stdio/SSE 传输形态按 §11.2 留待 harness 运行时需要时再补）——工具名、
// 参数、返回结构在此冻结，换传输不动业务代码。
//
// 三个工具与判分器 article-check 同源（server/playground/articles.ts）：
//   patent_law_search(query, k?)          向量+BM25+RRF+rerank 混合检索
//   patent_law_get_article(law, article)  条号目录直接取原文（无检索）
//   patent_law_verify_citation(citations) 批量存在性核验 + 返回原文
import type { KnowledgeSearchHit } from '../../shared/knowledge'
import { knowledgeSearch } from '../knowledge/search'
import { embedderConfig } from '../knowledge/settings'
import {
  LAW_ALIASES,
  extractCitations,
  locateArticle,
  normalizeText,
} from './articles'

export const MCP_SERVER_NAME = 'patent-law-mcp'

export interface McpToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export const PATENT_LAW_TOOLS: McpToolSpec[] = [
  {
    name: 'patent_law_search',
    description:
      '检索中国专利法律法规库（专利法/实施细则/审查指南/侵权与授权确权司法解释），返回最相关条文片段与来源。回答法律问题、引用条文前必须先调用本工具检索，不得凭记忆引用。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词，如 创造性 三步法 技术启示' },
        k: { type: 'number', description: '返回条数，默认 5，最大 10' },
      },
      required: ['query'],
    },
  },
  {
    name: 'patent_law_get_article',
    description: '按法律别名与条号直接取条文原文（不走检索）。law 取值：patent-law | implementing-regulations | infringement-interp-1 | infringement-interp-2 | grant-validation-interp-1 | patent-disputes-rules；审查指南章节用 section（如 第二部分第四章3.2.1.1）。',
    parameters: {
      type: 'object',
      properties: {
        law: { type: 'string' },
        article: { type: 'string', description: '阿拉伯数字条号，如 22' },
        section: { type: 'string', description: '审查指南章节路径（与 article 二选一）' },
      },
      required: ['law'],
    },
  },
  {
    name: 'patent_law_verify_citation',
    description:
      '批量核验条文引用是否真实存在并返回条文原文。citations 为字符串数组，每项写完整引用（如 "专利法第二十二条"、"专利法实施细则第六条"、"最高法专利纠纷若干规定第十三条"），也接受 "patent-law:22" 形式。不存在的条号必须判定 fabricated，不得继续引用。',
    parameters: {
      type: 'object',
      properties: {
        citations: {
          type: 'array',
          items: { type: 'string' },
          description: '待核验引用字符串列表',
        },
      },
      required: ['citations'],
    },
  },
]

export interface McpCallResult {
  ok: boolean
  tool: string
  /** Short summary used for the tool.result timeline event. */
  summary: string
  data: unknown
}

interface CitationItemInput {
  law?: string
  article?: string
  raw?: string
}

function normalizeCitationItem(item: unknown): CitationItemInput[] {
  if (typeof item === 'string') {
    // Compact "patent-law:22" form.
    const compact = item.match(/^\s*([a-z0-9-]+)\s*:\s*(\d+)\s*$/)
    if (compact && LAW_ALIASES.some((a) => a.key === compact[1])) {
      return [{ law: compact[1]!, article: compact[2]!, raw: item }]
    }
    const norm = normalizeText(item)
    const found = extractCitations(norm)
    if (found.length > 0) return found.map((c) => ({ law: c.lawKey, article: String(c.article), raw: c.raw }))
    // Bare "第22条" without a law name: default to patent-law.
    const m = item.match(/第\s*([0-9一二三四五六七八九十百零〇两]+)\s*条/)
    if (m) return [{ law: 'patent-law', article: m[1]!, raw: item }]
    return [{ raw: item }]
  }
  if (item && typeof item === 'object') {
    const o = item as { law?: unknown; article?: unknown }
    return [{ law: typeof o.law === 'string' ? o.law : undefined, article: typeof o.article === 'string' ? o.article : undefined }]
  }
  return []
}

function lawDisplayName(lawKey: string): string {
  return LAW_ALIASES.find((a) => a.key === lawKey)?.displayName ?? lawKey
}

/**
 * Dispatch one MCP tool call. Every call is deterministic given the KB state;
 * the runner is responsible for emitting tool.call/tool.result events around
 * it (MCP itself never writes events).
 */
export async function callPatentLawTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
  if (name === 'patent_law_search') {
    const query = String(args['query'] ?? '').trim()
    if (!query) return { ok: false, tool: name, summary: '缺少 query 参数', data: { error: 'query is required' } }
    const k = Math.max(1, Math.min(10, Number(args['k']) || 5))
    const emb = embedderConfig()
    if (!emb) {
      return {
        ok: false,
        tool: name,
        summary: '知识库 embedding 未配置（设置屏 → 知识库）',
        data: { error: 'embedder not configured; configure the knowledge-base embedding API in #/settings' },
      }
    }
    let hits: KnowledgeSearchHit[] = []
    try {
      hits = await knowledgeSearch(query, emb, { topK: k })
    } catch (err) {
      return { ok: false, tool: name, summary: `检索失败：${(err as Error).message}`, data: { error: (err as Error).message } }
    }
    const results = hits.map((h) => ({
      text: h.text,
      score: Number(h.score.toFixed(4)),
      source: String((h.metadata as Record<string, unknown>)['name'] ?? (h.metadata as Record<string, unknown>)['sourceId'] ?? ''),
      chunkId: h.chunkId,
    }))
    return {
      ok: true,
      tool: name,
      summary: `${results.length} 条命中（top ${results[0]?.score ?? 0}）：${results[0]?.source ?? ''}`,
      data: { query, results },
    }
  }

  if (name === 'patent_law_get_article') {
    const law = String(args['law'] ?? '')
    const article = args['article'] != null ? String(args['article']) : undefined
    const section = args['section'] != null ? String(args['section']) : undefined
    if (!law) return { ok: false, tool: name, summary: '缺少 law 参数', data: { error: 'law is required' } }
    const located = locateArticle({ law, article, section })
    if (!located) {
      return { ok: false, tool: name, summary: `${lawDisplayName(law)} 未定位到 ${section ? `章节 ${section}` : `第 ${article ?? '?'} 条`}`, data: { exists: false } }
    }
    return {
      ok: true,
      tool: name,
      summary: `${located.displayName}${located.article ? ` 第${located.article}条` : located.section ? ` ${located.section}` : ''}（${located.sourceName}）`,
      data: {
        exists: true,
        law: located.lawKey,
        displayName: located.displayName,
        source: located.sourceName,
        article: located.article,
        section: located.section,
        text: located.text,
      },
    }
  }

  if (name === 'patent_law_verify_citation') {
    const rawItems = Array.isArray(args['citations']) ? args['citations'] : []
    const items = rawItems.flatMap(normalizeCitationItem)
    const results = items.map((it) => {
      if (!it.law || (!it.article && !it.raw)) {
        return { input: it.raw ?? '', exists: false, error: '无法解析的引用（需要 law + article 或完整条号）' }
      }
      const located = locateArticle({ law: it.law, article: it.article })
      return {
        input: it.raw ?? `${it.law} 第${it.article}条`,
        law: it.law,
        displayName: lawDisplayName(it.law),
        article: it.article,
        exists: !!located,
        source: located?.sourceName,
        text: located?.text,
      }
    })
    const missing = results.filter((r) => !r.exists).length
    return {
      ok: missing === 0,
      tool: name,
      summary: `核验 ${results.length} 条：${results.length - missing} 存在 / ${missing} 不存在`,
      data: { results },
    }
  }

  return { ok: false, tool: name, summary: `未知工具：${name}`, data: { error: `unknown tool: ${name}` } }
}
