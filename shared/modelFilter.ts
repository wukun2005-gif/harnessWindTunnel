/**
 * 模型清单过滤：设置屏的 LLM Provider 页只列「大语言模型 + 多模态理解模型」，
 * 其余一律不列。
 *
 * 为什么用排除法而不是白名单：厂商每周都在放新型号（百炼一次就回 262 个），
 * 白名单会在每次上新时漏掉新模型。排除法只认「明确不是对话模型」的词根。
 *
 * 判据（2026-10 实测百炼 /models 262 条归纳）：
 *   排除 embedding / rerank / 语音（tts·asr·speech·audio·realtime）/ 图像视频 / 内容安全
 *   保留 omni / vision / vl —— 多模态理解模型仍是对话模型，判分与实跑都能用
 *   保留 coder / math / long / instruct / thinking 等用途分型：都是文本生成
 *
 * 判定模型卡（TypeSafe / OpenCode / OpenRouter 判定）走另一条路：只列 DECISION_MODEL_IDS
 * 白名单里的判定型号，理由见该常量上方注释。
 */

import { isDecisionProvider } from './provider'

/** 明确不是文本生成/多模态理解的品类。命中即排除。 */
const EXCLUDED_PATTERNS: readonly RegExp[] = [
  // 向量与排序：只能出 embedding / 相关性分数，不产出答复
  /(^|[-_/])embed(ding|dings)?([-_/]|$)/i,
  /(^|[-_/])rerank([-_/]|$)/i,
  /(^|[-_/])re?rank[-_]?(score|model)?([-_/]|$)/i,
  // 语音：合成、识别、流式音频对话（都不能直接当文本对话模型用）
  /(^|[-_/])tts([-_/]|$)/i,
  /(^|[-_/])asr([-_/]|$)/i,
  /speech/i,
  /(^|[-_/])audio([-_/]|$)/i,
  /(^|[-_/])voice([-_/]|$)/i,
  /whisper/i,
  // realtime 是音频流式通道（qwen3.8-omni-flash-realtime 也不是文本对话模型）
  /(^|[-_/])realtime([-_/]|$)/i,
  // 图像 / 视频生成
  /(^|[-_/])image([-_/]|$)/i,
  /(^|[-_/])img([-_/]|$)/i,
  /dall[-_]?e/i,
  /(^|[-_/])flux([-_/]|$)/i,
  /diffusion/i,
  /stable[-_]?diffusion/i,
  /(^|[-_/])video([-_/]|$)/i,
  /(^|[-_/])vid([-_/]|$)/i,
  /wan[0-9]/i,
  // 内容安全分类器
  /moderation/i,
  /(^|[-_/])guard([-_/]|$)/i,
  // 向量库 / 文件处理之类的工具型模型
  /(^|[-_/])(bge|gte|text2vec|m3)[-_]/i,
]

/**
 * 该 id 是否是可在设置屏选择的对话模型（LLM 或多模态理解模型）。
 * 未知型号默认放行 —— 宁可多列一个，也不把厂商新发的模型静默藏起来。
 */
export function isChatModel(modelId: string): boolean {
  const id = (modelId ?? '').trim()
  if (!id) return false
  return !EXCLUDED_PATTERNS.some((re) => re.test(id))
}

/** 过滤掉非对话模型，保持原顺序。 */
export function filterChatModels<T extends string>(ids: readonly T[]): T[] {
  return ids.filter(isChatModel)
}

/** 过滤 ModelInfo 列表（设置屏模型下拉用）。 */
export function filterChatModelInfos<T extends { id: string }>(models: readonly T[]): T[] {
  return models.filter((m) => isChatModel(m.id))
}

// ── 真·免费模型 ───────────────────────────────────────────────────────────

/**
 * 真正存在「免费档」的厂商。只有列在这里的厂商才套用免费过滤 —— 对没有免费
 * 档的厂商套用会把列表清空（百炼 262 个型号里 free 字样数为 0，且官方价目表
 * 上每个模型都有单价，它的「免费」是账号级一次性额度，API 取不到）。
 *
 * OpenCode 的免费档是型号名里直接带 `-free` 的稳定档位，可作为 id 级判据。
 */
const FREE_TIER_PROVIDERS: ReadonlySet<string> = new Set(['opencode'])

/** 该厂商是否有真实免费档。 */
export function hasFreeTier(providerId: string): boolean {
  return FREE_TIER_PROVIDERS.has(providerId)
}

/** 型号是否属于免费档（id 级判据：`-free` 后缀或独立 free 段）。 */
export function isFreeModel(modelId: string): boolean {
  const id = (modelId ?? '').trim()
  if (!id) return false
  return /(^|[-_/])free([-_]|$)/i.test(id)
}

/**
 * 某个厂商的模型清单该展示什么：
 *   1. 判定卡：只留判定型号（白名单，见 DECISION_MODEL_IDS）；
 *   2. 其余卡：先过品类过滤（只留对话 / 多模态理解模型）；
 *   3. 该厂商有免费档时，再只留免费档。
 *
 * 只决定「列表里有哪些可选」，不负责校验用户已经选中的型号 —— 已保存的
 * 选择即使不在候选列表里也必须保留，否则用户一改配置就丢。
 */
export function filterModelsForProvider<T extends string>(providerId: string, ids: readonly T[]): T[] {
  if (isDecisionProvider(providerId)) return filterDecisionModels(ids)
  const chat = filterChatModels(ids)
  if (!hasFreeTier(providerId)) return chat
  return chat.filter(isFreeModel)
}

/** filterModelsForProvider 的 ModelInfo 版本，元数据原样保留。 */
export function filterModelInfosForProvider<T extends { id: string }>(providerId: string, models: readonly T[]): T[] {
  const keep = new Set(filterModelsForProvider(providerId, models.map((m) => m.id)))
  return models.filter((m) => keep.has(m.id))
}

// ── 判定模型（System One / Decisions 通道，非 chat） ───────────────────────

/**
 * 判定型号白名单。判定模型是另一种协议：POST {baseUrl}/systemone，返回结构化读数
 * （Choice / Score / Noul + 概率），不生成自由文本，也没有 /chat/completions。
 * 判定卡上只列这些型号。
 *
 * 为什么判定侧用白名单、对话侧用排除法：对话侧是从一堆命名里猜「明显不是文本生成」
 * 的（百炼一次回 262 条，靠 embedding / tts 这类词根剔掉），猜错只是多列一个型号；
 * 判定侧反过来，猜错会把大模型型号当成判定型号列到判定卡上，然后按判定协议去打它、
 * 必然失败，而且没有明显提示。所以只认厂商明确标注的判定型号。
 *
 * 清单取自 OpenRouter 的判定型号目录 `GET /api/v1/models?output_modalities=decisions`
 * （2026-10-12 实测 19 条）。厂商上新判定型号时要在这里补一行，否则新型号不会出现在
 * 判定卡上——这是白名单唯一需要人工维护的地方。
 */
export const DECISION_MODEL_IDS: readonly string[] = [
  'typesafe/jev-1.13',
  '~typesafe/jev-latest',
  'openai/gpt-6-luna-decisions',
  'perplexity/pplx-decider-v1.1-27b',
  'cloudflare/clef',
  'cloudflare/clef-flash',
  'cloudflare/clef-omni',
  'inception/mercury-decide',
  'inception/mercury-decide:free',
  'nace-ai/drex-v1.5',
  'microsoft/microsoft-decision-1',
  'liquid/d1',
  'upstage/solar-decide',
  'upstage/solar-decide-flash',
  'respan/span-01',
  'respan/span-01-lite',
  'respan/span-01-lite:free',
  'togethercomputer/tev1-4b-experimental',
  'jaredpalmer/kev-4b',
]

const DECISION_MODEL_ID_SET: ReadonlySet<string> = new Set(DECISION_MODEL_IDS)

/** 该 id 是否是判定型号（System One，非 chat）。判定卡上只列这些。 */
export function isDecisionModel(modelId: string): boolean {
  return DECISION_MODEL_ID_SET.has((modelId ?? '').trim())
}

/** 过滤掉非判定型号，保持原顺序。 */
export function filterDecisionModels<T extends string>(ids: readonly T[]): T[] {
  return ids.filter(isDecisionModel)
}

/** 过滤 ModelInfo 列表（元数据原样保留）。 */
export function filterDecisionModelInfos<T extends { id: string }>(models: readonly T[]): T[] {
  return models.filter((m) => isDecisionModel(m.id))
}

/**
 * 该型号能否当「低置信回落的 chat 复核模型」——要排除两种：
 *   1. jev- 开头的托管判定型号（TypeSafe / OpenCode 两张卡的型号，只有 /systemone）；
 *   2. DECISION_MODEL_IDS 白名单里的判定型号（同理，只有判定通道）。
 *
 * 判定卡上只有带非判定型号时，这张卡才是有效回落目标；一张纯判定型号的卡不是。
 * 消费方：server/playground/jevSettings.ts 的 resolveChatJudgeTarget。
 */
export function isChatJudgeModel(modelId: string): boolean {
  const id = (modelId ?? '').trim()
  if (!id) return false
  return !/^jev/i.test(id) && !DECISION_MODEL_ID_SET.has(id)
}
