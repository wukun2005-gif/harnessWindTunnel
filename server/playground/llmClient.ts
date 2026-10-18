// M2 LLM client for live playground runs. Reuses the #/settings provider
// bundle (server-data/settings.json, raw keys server-side only — B-041) and
// speaks the OpenAI-compatible /chat/completions protocol (all preset cards
// except Gemini's native endpoint expose one; custom OpenAI-compatible
// gateways work as well).
import { getSetting } from '../settingsStore'
import { isDecisionProvider } from '../../shared/provider'
import { getModelCapabilities } from '../providers/model-capabilities-registry'
import { estimateTokens } from './tokens'
import { hostOf, llmLog, llmWarn } from './jevLog'
import { awaitProviderQuota } from './providerQuota'

export interface ChatToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ChatUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  toolCallId?: string
  name?: string
}

export interface ChatToolSpec {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type ChatResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> } }

export interface ChatRequest {
  messages: ChatMessage[]
  tools?: ChatToolSpec[]
  /**
   * OpenAI-style response_format. This is what turns "please emit JSON" from a
   * prompt convention into a structural guarantee: without it a model that does
   * not volunteer JSON (e.g. a reasoning model) silently breaks the judge.
   * Sent only when the resolved model is registered as supporting structured
   * output — an unregistered model would 400 on the field.
   */
  responseFormat?: ChatResponseFormat
  /**
   * Provider-specific passthrough fields merged into the request body last.
   * Exists for knobs the OpenAI schema does not cover but a provider honours —
   * e.g. Bailian/DashScope's `enable_thinking: false`, which cuts a
   * reasoning-heavy judge from ~10.6s to ~3.1s for a ~30-token JSON verdict.
   * Only use it for fields verified against the real endpoint.
   */
  extraBody?: Record<string, unknown>
  temperature?: number
  seed?: number
  maxTokens?: number
  signal?: AbortSignal
}

export interface ChatResponse {
  text: string
  toolCalls: ChatToolCall[]
  usage: ChatUsage | null
  stopReason: string
}

export interface ResolvedTarget {
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
}

interface StoredProvider {
  providerId?: string
  apiKeyRef?: string
  apiKey?: string
  baseUrl?: string
  modelIds?: string[]
  defaultModelId?: string
  enabled?: boolean
  /** 设置屏每张卡的「模型回退」列表（同服务商内失败换模型；列表头通常就是当前默认模型）。 */
  modelFallbacks?: string[]
  /** 设置屏每张卡的「模型回退」开关——与跨服务商的 Provider 回退相互独立。 */
  enableModelFallback?: boolean
}

interface StoredBundle {
  providers?: StoredProvider[]
  /** 设置屏「启用 Provider 回退」开关：失败时自动切换至下一个可用服务商。 */
  enableProviderFallback?: boolean
}

function readBundle(): { providers: StoredProvider[]; enableProviderFallback: boolean } {
  const bundle = getSetting('provider_all') as StoredBundle | null
  return {
    providers: Array.isArray(bundle?.providers) ? bundle!.providers! : [],
    enableProviderFallback: bundle?.enableProviderFallback ?? true,
  }
}

function keyOf(p: StoredProvider): string {
  if (p.apiKeyRef) return p.apiKeyRef
  if (p.apiKey) return p.apiKey
  const legacy = getSetting(`provider_${p.providerId}`) as StoredProvider | null
  return legacy?.apiKeyRef ?? legacy?.apiKey ?? ''
}

function baseUrlOf(p: StoredProvider): string {
  return (p.baseUrl ?? '').trim().replace(/\/+$/, '')
}

/** 设置屏「启用 Provider 回退」开关（默认开）。 */
export function providerFallbackEnabled(): boolean {
  return readBundle().enableProviderFallback !== false
}

/**
 * 单张卡的模型回退链：主模型在前；卡上「模型回退」开关开着才追加列表其余模型
 * （设置页把当前默认模型放在列表头，按值去重，主模型不会被重复尝试）。
 * 没配卡数据或开关关＝只打主模型，行为与实现该功能之前完全一致。
 */
function modelChain(t: ResolvedTarget): string[] {
  const { providers } = readBundle()
  const row = providers.find((p) => p.providerId === t.providerId)
    ?? (getSetting(`provider_${t.providerId}`) as StoredProvider | null)
  const list = row?.enableModelFallback ? (row.modelFallbacks ?? []) : []
  const chain = [t.model]
  for (const m of list) {
    const v = typeof m === 'string' ? m.trim() : ''
    if (v && !chain.includes(v)) chain.push(v)
  }
  return chain
}

/**
 * 可用 chat 目标链（主目标在前，按设置屏拖出来的卡顺序：先「启用且可用」，再「可用」）。
 * 判定模型卡被排除——它走 System One 协议，没有 /chat/completions，永远不是 chat 目标。
 */
export function resolveChatTargets(opts: { providerId?: string; model?: string } = {}): { targets: ResolvedTarget[] } | { error: string } {
  const { providers } = readBundle()
  const chatProviders = providers.filter((p) => !p.providerId || !isDecisionProvider(p.providerId))
  const usable = (p: StoredProvider): boolean => !!keyOf(p) && !!baseUrlOf(p)
  const ordered: StoredProvider[] = [
    ...chatProviders.filter((p) => p.enabled && usable(p)),
    ...chatProviders.filter((p) => !(p.enabled && usable(p)) && usable(p)),
  ]

  let primaryRow: StoredProvider | undefined
  if (opts.providerId) {
    primaryRow = chatProviders.find((p) => p.providerId === opts.providerId)
    if (!primaryRow) return { error: `设置中找不到 provider：${opts.providerId}` }
    const at = ordered.indexOf(primaryRow)
    if (at >= 0) ordered.splice(at, 1)
  } else {
    primaryRow = ordered.shift()
    if (!primaryRow) return { error: '尚未在 #/settings 配置可用的 LLM provider（需要 baseUrl + API key + 模型）' }
  }

  const apiKey = keyOf(primaryRow)
  if (!apiKey) return { error: `provider ${primaryRow.providerId} 缺少 API key（请到 #/settings 填写）` }
  const baseUrl = baseUrlOf(primaryRow)
  if (!baseUrl) return { error: `provider ${primaryRow.providerId} 缺少 baseUrl` }
  const model = opts.model?.trim() || primaryRow.defaultModelId || primaryRow.modelIds?.[0] || ''
  if (!model) return { error: `provider ${primaryRow.providerId} 未选择模型` }

  const targets: ResolvedTarget[] = [{ providerId: primaryRow.providerId ?? 'custom', baseUrl, apiKey, model }]
  for (const p of ordered) {
    if (p === primaryRow) continue
    const k = keyOf(p)
    const b = baseUrlOf(p)
    const m = (p.defaultModelId ?? '').trim() || p.modelIds?.[0] || ''
    if (!k || !b || !m) continue
    targets.push({ providerId: p.providerId ?? 'custom', baseUrl: b, apiKey: k, model: m })
  }
  return { targets }
}

/** 主 chat 目标（回退链头）：首个可用目标，或给出设置屏可操作的错误。 */
export function resolveChatTarget(opts: { providerId?: string; model?: string } = {}): ResolvedTarget | { error: string } {
  const chain = resolveChatTargets(opts)
  if ('error' in chain) return chain
  return chain.targets[0]!
}

function estimateUsage(text: string): ChatUsage {
  // Last-resort local estimate only when the API omits usage (clearly marked
  // estimated at the UI layer via tokensProvenance downstream).
  const n = estimateTokens(text)
  return { promptTokens: 0, completionTokens: n, totalTokens: n }
}

/** One OpenAI-compatible chat completion round. Throws on transport/HTTP errors. */
/**
 * 结构化失败诊断：只取「定位故障方」所需的元数据，不取正文。
 *
 * 之前「2xx 但没有 choices」这条路径把响应体整个丢掉，错误只剩一句
 * 「LLM API 返回缺少 choices」——既分不出是 OpenRouter 自己拒的还是上游 provider 拒的，
 * 也看不到限流余量。这里把 OpenRouter 的两类 429 区分依据原样带出来：
 *   metadata.error_type   = OpenRouter 侧（如 rate_limit_exceeded）
 *   metadata.provider_code = 上游 provider 的原始错误码
 * 外加 X-RateLimit-* / Retry-After。**正文（模型输出 / 答案）永不进日志**（B-041）。
 */
function describeFailure(r: Response, bodyText: string): string {
  const parts: string[] = [`status=${r.status}`]
  for (const [label, header] of [
    ['ratelimitRemaining', 'x-ratelimit-remaining'],
    ['ratelimitLimit', 'x-ratelimit-limit'],
    ['retryAfter', 'retry-after'],
  ] as const) {
    const v = r.headers.get(header)
    if (v != null) parts.push(`${label}=${v}`)
  }
  try {
    const j = JSON.parse(bodyText) as {
      error?: { code?: unknown; message?: unknown; type?: unknown }
      metadata?: { provider_code?: unknown; error_type?: unknown; raw?: unknown }
    }
    // 顶层键本身就很能说明问题：正常应答是 id/choices/...，异常回包是 error/metadata。
    parts.push(`bodyKeys=${Object.keys(j).join(',') || '(none)'}`)
    if (j.error?.code != null) parts.push(`error.code=${String(j.error.code)}`)
    if (j.error?.type != null) parts.push(`error.type=${String(j.error.type)}`)
    if (j.error?.message != null) parts.push(`error.message=${String(j.error.message).slice(0, 160)}`)
    if (j.metadata?.error_type != null) parts.push(`metadata.error_type=${String(j.metadata.error_type)}`)
    if (j.metadata?.provider_code != null) parts.push(`metadata.provider_code=${String(j.metadata.provider_code)}`)
  } catch {
    // 解析不了就只报长度，绝不落正文。
    parts.push(`body=unparseable(${bodyText.length} chars)`)
  }
  return parts.join(' ')
}

/**
 * 2xx 里嵌的错误码。OpenRouter 会把上游失败塞进一个 HTTP 200 的响应体里
 * （实测：`{"id":…,"error":{"code":502,"message":"JSON error injected into SSE stream"}}`），
 * 这时 `response.ok` 为真、状态码毫无信息量。把嵌入码取出来挂到 error.status 上，
 * classifyFallback 才能按真实语义分类：401＝整链停、429＝换目标、5xx＝同目标退避重试。
 */
function embeddedStatusCode(bodyText: string): number | null {
  try {
    const j = JSON.parse(bodyText) as { error?: { code?: unknown } }
    const c = j.error?.code
    if (typeof c === 'number' && Number.isFinite(c)) return c
    if (typeof c === 'string' && /^\d{3}$/.test(c)) return Number(c)
  } catch {
    /* 非 JSON：由 describeFailure 报长度 */
  }
  return null
}

/** 构造带状态码的错误，供 classifyFallback 使用。 */
function httpLikeError(message: string, bodyText: string): Error {
  const err = new Error(message)
  const code = embeddedStatusCode(bodyText)
  if (code != null) (err as Error & { status?: number }).status = code
  return err
}

export async function chatCompletion(target: ResolvedTarget, req: ChatRequest): Promise<ChatResponse> {
  const body: Record<string, unknown> = {
    model: target.model,
    messages: req.messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.arguments } })),
        }
      }
      return { role: m.role, content: m.content }
    }),
    temperature: req.temperature ?? 0.2,
  }
  if (req.seed != null) body['seed'] = req.seed
  if (req.maxTokens) body['max_tokens'] = req.maxTokens
  if (req.tools && req.tools.length > 0) {
    body['tools'] = req.tools
    body['tool_choice'] = 'auto'
  }
  if (req.responseFormat) {
    // Capability-gated on purpose: sending response_format to a model that does
    // not advertise it earns a 400, and that failure used to look like "the
    // judge model cannot produce JSON" rather than "we asked for the wrong thing".
    if (getModelCapabilities(target.model).supportsStructuredOutput) {
      body['response_format'] = req.responseFormat
    } else {
      llmWarn(`response_format skipped ← ${target.providerId}/${target.model}: not registered as supporting structured output`)
    }
  }

  if (req.extraBody) Object.assign(body, req.extraBody)

  // Spend the provider quota only once a request slot is free (shared with the
  // judge — see providerQuota.ts). Waiting here instead of 429-ing is what lets
  // callers keep more runs in flight than the quota alone would allow.
  await awaitProviderQuota(target.baseUrl)

  const started = Date.now()
  const where = `${target.providerId}/${target.model}@${hostOf(target.baseUrl)}`
  llmLog(`call → ${where}`)
  const response = await (async () => {
    try {
      const r = await fetch(`${target.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiKey}` },
        body: JSON.stringify(body),
        signal: req.signal ?? AbortSignal.timeout(180_000),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        llmWarn(`HTTP ${r.status} ← ${where} latencyMs=${Date.now() - started}: ${describeFailure(r, text)}`)
        const httpErr = new Error(`LLM API HTTP ${r.status}: ${text.slice(0, 400)}`)
        ;(httpErr as Error & { status?: number }).status = r.status
        throw httpErr
      }
      return r
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('LLM API HTTP')) throw err
      llmWarn(`network fail ← ${where} latencyMs=${Date.now() - started}: ${err instanceof Error ? err.message : String(err)}`)
      throw err
    }
  })()
  // 先取原文再解析：2xx 但没有 choices 时也要能说清是谁拒的（见 describeFailure）。
  const rawBody = await response.text()
  let data: {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  try {
    data = JSON.parse(rawBody) as typeof data
  } catch {
    const diag = describeFailure(response, rawBody)
    llmWarn(`非 JSON 应答 ← ${where} latencyMs=${Date.now() - started}: ${diag}`)
    throw httpLikeError(`LLM API 返回非 JSON 应答（${diag}）`, rawBody)
  }
  const choice = data.choices?.[0]
  if (!choice) {
    const diag = describeFailure(response, rawBody)
    llmWarn(`缺少 choices ← ${where} latencyMs=${Date.now() - started}: ${diag}`)
    throw httpLikeError(`LLM API 返回缺少 choices（${diag}）`, rawBody)
  }

  const text = choice.message?.content ?? ''
  const toolCalls: ChatToolCall[] = (choice.message?.tool_calls ?? [])
    .filter((tc) => tc.function?.name)
    .map((tc, i) => {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = tc.function!.arguments ? JSON.parse(tc.function!.arguments) as Record<string, unknown> : {}
      } catch {
        parsed = { _parseError: tc.function!.arguments ?? '' }
      }
      return { id: tc.id ?? `call_${i}`, name: tc.function!.name!, arguments: parsed }
    })

  const usage: ChatUsage | null = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        totalTokens: data.usage.total_tokens ?? (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0),
      }
    : null

  llmLog(
    `ok ← ${where} latencyMs=${Date.now() - started} tokens=${usage ? `${usage.promptTokens}+${usage.completionTokens}` : '(estimated)'}`,
  )

  return {
    text,
    toolCalls,
    usage: usage ?? estimateUsage(req.messages.map((m) => m.content).join('')),
    stopReason: choice.finish_reason ?? 'stop',
  }
}

export interface ChatResponseWithFallback extends ChatResponse {
  /** 实际应答方——发生回退（换服务商或换模型）时与入参 primary 不同。 */
  used: { providerId: string; model: string }
  /** 偏离原目标（主服务商失败已切换）时的失败现场：首个失败尝试的现场，未发生回退则缺省。 */
  switchedFrom?: { providerId: string; model: string; reason: string }
}

/** 回退选项：validate＝内容级校验（失败即该次尝试失败、进回退链）；backoff/timeout 供测试覆盖。 */
export interface ChatFallbackOptions {
  /** 对 2xx 应答正文做校验；抛错＝这次尝试失败（照搬成熟方案：解析失败必须触发换模型重试）。 */
  validate?: (text: string) => void
  /** 同目标（同模型）退避间隔，第 1/2 次重试用；缺省 [500, 1500]（可用 HWT_FB_BACKOFF_MS='500,1500' 覆盖）。 */
  backoffMs?: [number, number]
  /** 单请求超时；缺省 120_000ms（可用 HWT_FB_TIMEOUT_MS 覆盖）。 */
  timeoutMs?: number
  /**
   * false ＝ 只打主目标的主模型：不换模型、不换服务商。
   * **同目标的重试与退避照旧**（那不会改变模型身份），被砍掉的只有「换目标」。
   * 评测路径固定传 false —— 见 EVAL_LOCK。
   */
  allowFallback?: boolean
}

/**
 * 评测路径的硬锁：一次 run（及其判定复核）的模型必须全程不变。
 *
 * 为什么必须锁：回退会在 run 中途换模型或换服务商，于是同一条 run 的答案由不同模型产出，
 * 「harness 的差异」就和「模型的差异」混在一起，分数不可解释。做 harness 对比时，
 * 宁可让 run 明确失败，也不要悄悄换一个模型把结果变得看似成功。
 *
 * 这是**代码常量，不是设置项**：设置屏那两个「启用 Provider 回退 / 模型回退」开关
 * 在评测路径上不生效（它们仍供非评测用途的 chatCompletionWithFallback 默认行为使用）。
 */
export const EVAL_LOCK: ChatFallbackOptions = { allowFallback: false }

type FbClass = 'auth' | 'bad-request' | 'quota' | 'server' | 'timeout' | 'validate' | 'network'

/** 错误分类（照搬 patentExaminator registry.classifyError 语义）：401＝整链停；4xx＝不换目标重试；
 *  5xx/超时/网络＝同目标退避重试后再换目标；validate＝内容级失败，直接换下一个目标。 */
function classifyFallback(err: unknown): FbClass {
  if (err instanceof Error) {
    const kind = (err as Error & { kind?: string }).kind
    if (kind === 'validate') return 'validate'
    if (kind === 'timeout') return 'timeout'
    const st = (err as Error & { status?: number }).status ?? Number(/LLM API HTTP (\d{3})/.exec(err.message)?.[1] ?? 0)
    if (st === 401) return 'auth'
    if (st === 403 || st === 429) return 'quota'
    if (st >= 500) return 'server'
    if (st >= 400) return 'bad-request'
  }
  return 'network'
}

const sameTargetRetryable = (c: FbClass): boolean => c === 'server' || c === 'timeout' || c === 'network'

/** 链停标记（鉴权失败 / 封顶）：外层不再换服务商继续。 */
function stopChain<T>(err: T): T {
  if (err instanceof Error) (err as Error & { noFallback?: boolean }).noFallback = true
  return err
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function parseBackoffEnv(v: string | undefined): [number, number] | null {
  if (!v) return null
  const parts = v.split(',').map((s) => Number(s.trim()))
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  return [parts[0]!, parts[1]!]
}

/**
 * 一轮 chat，带完整两级回退语义（照搬 patentExaminator 的成熟机制）：
 *   1）错误分类：401 鉴权失败＝整链停止、原错误透出（换模型/换服务商救不回配置错）；
 *      4xx（含 403/429 配额）＝不换目标重试、直接换下一个模型/服务商；
 *      5xx / 超时 / 网络错误＝同目标先指数退避重试 2 次（500ms、1500ms），仍失败再换下一个目标；
 *      2xx 但正文过不了 validate（内容级失败，如 JSON 解析不出读数）＝这次尝试失败进回退链；
 *   2）模型回退（每张卡自己的「模型回退」开关＋列表）：同服务商内按卡上列表顺序换模型重试同一请求；
 *   3）Provider 回退（「启用 Provider 回退」总开关）：同卡模型用尽后，按设置屏的卡顺序切到下一个
 *      可用服务商（下一张卡同样先走它自己的模型回退列表）；
 *   4）全链封顶：模型级尝试最多 8 次（防几百个回退模型的列表把一次判定拖成马拉松）；
 *   5）单请求超时 120s，超时按可重试类处理；请求已中止＝不回退、原样抛出。
 * 无处可退时：单目标单模型（两级开关都没起作用过）直接抛出原始错误——与实现回退之前完全一致；
 * 只要多试过一次，就把整条尝试链汇总进错误里。
 * 只回退到非判定模型卡——判定卡没有 /chat/completions。
 * 发生任何一级回退都记 switchedFrom（首个失败现场，供调用方把后续请求钉在实际应答方上），
 * 实际应答方记在 used 里。
 */
export async function chatCompletionWithFallback(
  primary: ResolvedTarget,
  req: ChatRequest,
  opts: ChatFallbackOptions = {},
): Promise<ChatResponseWithFallback> {
  const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  const origin = { providerId: primary.providerId, model: primary.model }
  const attempts: string[] = []
  let lastErr: unknown = null
  let modelTries = 0

  const backoffMs = opts.backoffMs ?? parseBackoffEnv(process.env['HWT_FB_BACKOFF_MS']) ?? ([500, 1500] as [number, number])
  const timeoutMs = opts.timeoutMs ?? (Number(process.env['HWT_FB_TIMEOUT_MS'] ?? '') || 120_000)
  const MAX_TOTAL_ATTEMPTS = 8
  /** 评测路径传 false：只打主目标主模型，同目标重试照旧。 */
  const allowFallback = opts.allowFallback !== false

  /** 尝试链摘要：过长时截断（一张卡可以配几百个回退模型，逐条进错误没有意义）。 */
  const summarize = (): string =>
    attempts.length > 6
      ? `${attempts.slice(0, 6).join('；')}…（共 ${attempts.length} 次尝试）`
      : attempts.join('；')

  /** 单次请求：超时桥（客户端中止透传；超时按可重试类处理）＋内容级校验。 */
  const callOnce = async (t: ResolvedTarget, m: string): Promise<ChatResponse> => {
    const ctrl = new AbortController()
    const relayAbort = (): void => { ctrl.abort() }
    if (req.signal) {
      if (req.signal.aborted) ctrl.abort()
      else req.signal.addEventListener('abort', relayAbort, { once: true })
    }
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
    try {
      const res = await chatCompletion({ ...t, model: m }, { ...req, signal: ctrl.signal })
      if (opts.validate) {
        try {
          opts.validate(res.text)
        } catch (ve) {
          const e = ve instanceof Error ? ve : new Error(String(ve))
          ;(e as Error & { kind?: string }).kind = 'validate'
          throw e
        }
      }
      return res
    } catch (err) {
      if (timedOut && !req.signal?.aborted) {
        const e = new Error(`LLM 请求超时（${timeoutMs}ms）`)
        ;(e as Error & { kind?: string }).kind = 'timeout'
        llmWarn(`timeout ← ${t.providerId}/${m}: ${e.message}`)
        throw e
      }
      throw err
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', relayAbort)
    }
  }

  /** 单张卡的模型回退链：主模型在前；链尽/封顶抛最后一次错误（每次换模型失败都进 attempts）。 */
  const runCard = async (t: ResolvedTarget): Promise<ChatResponseWithFallback> => {
    const models = allowFallback ? modelChain(t) : [t.model]
    for (let i = 0; i < models.length; i++) {
      if (modelTries >= MAX_TOTAL_ATTEMPTS) {
        llmWarn(`回退封顶（${MAX_TOTAL_ATTEMPTS} 次模型尝试） ← ${attempts[0] ?? `${origin.providerId}/${origin.model}`}`)
        throw stopChain(new Error(`回退尝试已达 ${MAX_TOTAL_ATTEMPTS} 次上限：${summarize() || '（无成功尝试）'}`))
      }
      modelTries++
      const m = models[i]!
      let retries = 0
      for (;;) {
        try {
          const res = await callOnce(t, m)
          const used = { providerId: t.providerId, model: m }
          if (used.providerId === origin.providerId && used.model === origin.model) return { ...res, used }
          if (attempts.length > 0) llmLog(`model fallback ok ← ${t.providerId}/${m}（原 ${origin.providerId}/${origin.model} 已失败）`)
          return { ...res, used, switchedFrom: { ...origin, reason: attempts[0] ?? '' } }
        } catch (err) {
          if (req.signal?.aborted) throw err
          const cls = classifyFallback(err)
          if (cls === 'auth') {
            llmWarn(`auth-failed 停止回退 ← ${t.providerId}/${m}: ${describe(err)}`)
            throw stopChain(err)
          }
          if (retries < 2 && sameTargetRetryable(cls)) {
            retries++
            const delay = backoffMs[retries - 1] ?? 0
            llmWarn(`${cls} ← ${t.providerId}/${m}: ${describe(err)}（同目标退避 ${delay}ms 后重试 ${retries}/2）`)
            if (delay > 0) await sleep(delay)
            continue
          }
          attempts.push(`${t.providerId}/${m}: ${describe(err)}`)
          llmWarn(`尝试失败（${cls}）← ${t.providerId}/${m}: ${describe(err)}（继续回退）`)
          lastErr = err
          break
        }
      }
    }
    throw lastErr
  }

  try {
    return await runCard(primary)
  } catch (err) {
    if (req.signal?.aborted) throw err
    if ((err as Error & { noFallback?: boolean })?.noFallback) throw err
    const chain = allowFallback && providerFallbackEnabled() ? resolveChatTargets({}) : { targets: [] as ResolvedTarget[] }
    const candidates = 'error' in chain ? [] : chain.targets.filter((t) => t.providerId !== primary.providerId)
    // 没有下一个可用服务商：只试过一次＝原始错误原样透出；多试过（模型回退发生过）＝带整条链。
    if (candidates.length === 0) {
      throw attempts.length <= 1 ? err : new Error(`模型回退均失败：${summarize()}`)
    }
    llmWarn(`provider fallback 启动 ← ${attempts[0] ?? `${origin.providerId}/${origin.model}`}`)
    for (const t of candidates) {
      try {
        return await runCard(t)
      } catch (e2) {
        if (req.signal?.aborted) throw e2
        if ((e2 as Error & { noFallback?: boolean })?.noFallback) throw e2
      }
    }
    throw new Error(`所有可用服务商均失败：${summarize()}`)
  }
}
