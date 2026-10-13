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
import type { SearchResultItem, SearchProviderId } from '../../shared/search'
import { knowledgeSearch } from '../knowledge/search'
import { embedderConfig, searchProviderById } from '../knowledge/settings'
import { searchPatents } from '../search/webSearch'
import {
  EVAL_LOCK,
  chatCompletionWithFallback,
  resolveChatTarget,
  type ChatResponseFormat,
} from './llmClient'
import {
  LAW_ALIASES,
  extractCitations,
  locateArticle,
  normalizeText,
} from './articles'

/**
 * Chat hook the MCP uses for its sufficiency judge. Kept injectable so offline
 * tests can run the tool with no network: no hook → no judgement → no web call.
 */
export interface McpLlm {
  chat: (system: string, user: string) => Promise<{ text: string; tokens: number }>
}

/**
 * The judge model for the internal retrieval-sufficiency decision — ONE model,
 * pinned, never swapped mid-batch (see RAG_JUDGE_MODEL below).
 *
 * Chosen by an empirical bake-off (scripts/eval-rag-judge-models.py; raw results
 * in server-data/batch270/rag-judge-bakeoff.json) over 8 cases whose expected
 * labels were verified against the ACTUAL top-5 local hits:
 *
 *   qwen3.8-max-0902      7/8 · 8/8 JSON · ~9.5s/call · 991K left, exp 12/01  ← chosen
 *   deepseek-v4.1-flash   6/8 · 7/8 JSON · ~5.3s/call · 990K left, exp 12/13
 *   qwen3.8-2.4t-a95b     7/8 · 8/8 JSON · ~10.8s/call · 938K left, exp 11/12
 *
 * qwen3.8-max-0902 leads on reliability — it never once failed to return
 * parseable JSON across two independent 8-case runs, whereas deepseek-v4.1-flash
 * silently returned nothing parseable on 1 of 8 (a parse failure means no web
 * augmentation at all, which is a silent degradation, so reliability outranks
 * deepseek's 2× speed edge here). The single shared miss is an ambiguous case
 * whose query literally asks for "原文" while the prompt says verbatim wording
 * is not required — both models answered it the defensible way.
 *
 * Deliberately NOT the run's own model: "is retrieval good enough" is a property
 * of the retrieval pipeline and must not drift when the answer model changes.
 * Deliberately on Bailian rather than OpenRouter: the judge must not compete
 * with the answer model for OpenRouter's shared 20 RPM / 1000-per-day free quota.
 *
 * The OpenRouter free pool was measured and rejected for this job:
 *   thinkingmachines/inkling*:free      → 403 "only available on agentic harnesses"
 *   google/gemma-4-31b-it:free          → 429 upstream rate-limited
 *   nvidia/nemotron-3.5-lightning:free  → runs, but 0/8 returned parseable JSON
 */
export const RAG_JUDGE_MODEL: { providerId: string; model: string } = {
  providerId: 'bailian',
  model: 'deepseek-v4.1-flash',
}

/**
 * Reasoning off for the judge. Measured on this exact model+prompt: the verdict
 * is a ~30-token JSON object, but with thinking on the model spends ~390
 * reasoning tokens and ~10.6s per call; with `enable_thinking: false` it is
 * ~3.1s and 8/8 parseable, with accuracy unchanged-to-better (7/8 vs 6/8 on the
 * 8-case set). 2.7 judge calls per run makes that ~20 minutes across 63 runs.
 *
 * Verified against the real Bailian endpoint (2026-10-12). `qwen3.8-2.4t-a95b`
 * rejects this field outright (every call errored), which is why it is not the
 * judge despite comparable quota.
 */
const JUDGE_EXTRA_BODY: Record<string, unknown> = { enable_thinking: false }

/**
 * PINNED web-search provider — one provider, never swapped.
 *
 * Tavily is the only configured adapter that does a patent-domain pass first
 * (patents.google.com + patentscope.wipo.int) before the general web pass, which
 * is what this patent-law task needs; SerpAPI's free tier is 100/month (too
 * small for ~170 searches), and EPO OPS returns structured patent data through a
 * heavier adapter. It is also the provider every already-run C2 run used, so
 * pinning it keeps "C2 vs C2 + web" differing by web-on/off and nothing else.
 *
 * Resolved by id, NOT via activeSearchProvider()'s "first enabled wins" — that
 * would silently follow the settings array order and change the harness if the
 * order ever shifted.
 */
export const PINNED_SEARCH_PROVIDER: SearchProviderId = 'tavily'

/**
 * PINNED TO ONE MODEL — deliberately NO fallback chain.
 *
 * The sufficiency gate is part of the harness. If it silently switched models
 * mid-batch, "C2 + web" would stop being one harness and runs judged by
 * different models would not be comparable. A judge failure must therefore
 * surface (and get the run rejected and re-run) instead of being papered over
 * by a different model.
 */
export function createRagJudgeLlm(): McpLlm {
  return {
    chat: async (system, user) => {
      const target = resolveChatTarget(RAG_JUDGE_MODEL)
      if ('error' in target) throw new Error(target.error)
      const res = await chatCompletionWithFallback(
        target,
        {
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          temperature: 0,
          maxTokens: 512,
          responseFormat: SUFFICIENCY_FORMAT,
          extraBody: JUDGE_EXTRA_BODY,
        },
        EVAL_LOCK,
      )
      return { text: res.text, tokens: res.usage?.totalTokens ?? 0 }
    },
  }
}

/** Internal "is the local retrieval good enough?" reading. */
export interface SufficiencyReading {
  sufficient: boolean
  reason: string
  /** Query to hand to web search when the local hits are not enough. */
  webQuery: string | null
  /** Tokens the judgement cost, so the run's accounting can include it. */
  tokens: number
}

/**
 * patentExaminator's RAG pipeline decided, with an LLM, whether the retrieved
 * passages were good enough, and only searched the web when they were not.
 * That decision is preserved here, inside the tool: the evaluated agent still
 * sees one "search" tool, so the harness comparison is not confounded by the
 * agent's own routing choices.
 */
const SUFFICIENCY_SYSTEM = [
  '你是检索充分性判定员。给定【问题】与【本地法库检索到的片段】，判断这些片段是否足以回答该问题。',
  '判定标准（重要）：',
  '1) 只要片段覆盖了回答问题所需的要点（法律条文 / 审查标准 / 事实）就算充分——不要求逐字原文，释义、改写、部分引用都算。',
  '2) 片段与问题主题相关、但没有回答到问题所问的具体点时，判不充分。',
  '3) 只看片段内容，不要用你自己的法律知识替它补全。',
  '4) 必须用中文回答。',
  '只输出一个 JSON 对象，不要输出其它任何文字：',
  '{"sufficient": true|false, "reason": "一句话理由（中文）", "webQuery": "若不足，给一条用于联网检索的查询式；足够则填空串"}',
].join('\n')

/**
 * Structural guarantee for the reading — `json_object`, not `json_schema`.
 *
 * The judge model (deepseek-v4.1-flash) rejects `json_schema` with HTTP 400
 * ("This response_format type is unavailable now") but accepts `json_object`,
 * verified against the real endpoint 2026-10-12. `json_object` still buys the
 * thing that matters here — the API enforces syntactically valid JSON — while
 * the exact shape stays a prompt contract, which the bake-off showed this model
 * honours (8/8 parseable).
 */
const SUFFICIENCY_FORMAT: ChatResponseFormat = { type: 'json_object' }

function parseSufficiency(text: string): Omit<SufficiencyReading, 'tokens'> | null {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const o = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>
    if (typeof o['sufficient'] !== 'boolean') return null
    const q = typeof o['webQuery'] === 'string' ? o['webQuery'].trim() : ''
    return {
      sufficient: o['sufficient'],
      reason: typeof o['reason'] === 'string' ? o['reason'].slice(0, 300) : '',
      webQuery: q ? q.slice(0, 200) : null,
    }
  } catch {
    return null
  }
}

/** No hook injected (offline tests) → no judgement, so no web augmentation. */
async function judgeSufficiency(
  query: string,
  hits: KnowledgeSearchHit[],
  llm?: McpLlm,
): Promise<SufficiencyReading | null> {
  if (!llm) return null
  const digest = hits.slice(0, 5).map((h, i) => {
    const src = String((h.metadata as Record<string, unknown>)['name'] ?? '')
    return `${i + 1}. （${src}）${h.text.replace(/\s+/g, ' ').slice(0, 400)}`
  }).join('\n')
  try {
    const res = await llm.chat(SUFFICIENCY_SYSTEM, `【问题】\n${query}\n\n【本地片段】\n${digest}`)
    const v = parseSufficiency(res.text)
    return v ? { ...v, tokens: res.tokens } : null
  } catch {
    return null
  }
}

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
      '检索中国专利法律法规库（专利法/实施细则/审查指南/侵权与授权确权司法解释），返回最相关条文片段与来源。回答法律问题、引用条文前必须先调用本工具检索，不得凭记忆引用。'
      + '若本地法库片段不足以回答问题，本工具会自动联网检索并在 webResults 里补上外部结果（附 url）——webResults 非空即表示本地不足，引用外部结论时须给出其 url。',
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
export async function callPatentLawTool(
  name: string,
  args: Record<string, unknown>,
  llm?: McpLlm,
): Promise<McpCallResult> {
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
    // 措辞刻意是「相似片段」不是「命中」：向量近邻检索在库里没有对应条文时照样返回
    // 最相似的 k 条，写「5 条命中（top 0.96）」会被 agent 读成「条文存在」——反编造题
    // （L3）实测被这个措辞带偏：检索说高分命中、核验说不存在，模型采信了检索。
    const top = results[0]?.score ?? 0

    // ── 充分性判定 → 不足才联网（patentExaminator RAG pipeline 的同款逻辑） ──
    const sufficiency = await judgeSufficiency(query, hits, llm)
    let webResults: SearchResultItem[] = []
    if (sufficiency && !sufficiency.sufficient) {
      const provider = searchProviderById(PINNED_SEARCH_PROVIDER)
      if (provider) {
        try {
          const wr = await searchPatents(sufficiency.webQuery ?? query, 5, provider)
          webResults = wr.results.slice(0, 5)
        } catch {
          // 联网失败不影响本地结果：检索工具仍要给出能给出的东西
        }
      }
    }
    const webAugmented = webResults.length > 0
    const aug = sufficiency
      ? sufficiency.sufficient
        ? '；充分性判定：本地已足够，未联网'
        : webAugmented
          ? `；充分性判定：本地不足（${sufficiency.reason || '未说明'}）→ 已联网补 ${webResults.length} 条`
          : `；充分性判定：本地不足，但联网未取到结果（${sufficiency.reason || '未说明'}）`
      : ''
    return {
      ok: true,
      tool: name,
      summary: `${results.length} 条相似片段（top ${top}；相似≠存在，引用前必须调用 patent_law_verify_citation 核验）：${results[0]?.source ?? ''}${aug}`,
      data: {
        query,
        results,
        sufficiency,
        judgeTokens: sufficiency?.tokens ?? 0,
        webAugmented,
        webResults: webResults.map((r) => ({
          title: r.title,
          url: r.url,
          content: r.content.slice(0, 1200),
          score: r.score,
        })),
      },
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
