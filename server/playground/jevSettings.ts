// Playground 的 Jev 开关（M1）—— 落 server-data/settings.json 的 `playground_jev` 行。
//
// 开关语义（写死在服务端，避免任何调用点自行解释）：
//   enabled = false（默认）→ Playground 全程不调用 Jev，一次也不出网；
//   enabled = true        → 按 jev-harness-research-v0.1.html 的建议使用：判分旁路复核
//                           （Choice + Score + Noul 打包在一次请求），置信度低于阈值回落
//                           chat LLM，安全域只做旁路、不参与定分。
//
// 凭据 / 端点 / 型号不存在这里：复用设置屏 LLM Provider tab 的 `provider_all` 行
// （Jev 卡可与任意 chat provider 同时启用），B-041：密钥不出服务端。
import {
  DEFAULT_JEV_SCENARIO_THRESHOLDS,
  DEFAULT_JEV_SETTINGS,
  JEV_DEFAULT_MODEL,
  JEV_OPENCODE_DEFAULT_MODEL,
  JEV_PROVIDER_IDS,
  JEV_PROVIDER_ID_OPENCODE,
  JEV_SCENARIOS,
  clampJevThreshold,
  type JevScenario,
  type JevSettings,
  type JevSettingsPatch,
  type JevSettingsView,
} from '../../shared/jev'
import { isDecisionProvider } from '../../shared/provider'
import { getSetting, putSetting } from '../settingsStore'
import type { JevTarget } from './jevClient'

const SETTINGS_KEY = 'playground_jev'

interface StoredProvider {
  providerId?: string
  apiKeyRef?: string
  apiKey?: string
  baseUrl?: string
  modelIds?: string[]
  modelFallbacks?: string[]
  defaultModelId?: string
  enabled?: boolean
}

function providerRows(): StoredProvider[] {
  const bundle = getSetting('provider_all') as { providers?: StoredProvider[] } | null
  return Array.isArray(bundle?.providers) ? bundle!.providers! : []
}

/** 与 server/playground/llmClient.ts 同款：兼容 provider_{id} 旧行。 */
function keyOf(p: StoredProvider): string {
  if (p.apiKeyRef) return p.apiKeyRef
  if (p.apiKey) return p.apiKey
  const legacy = getSetting(`provider_${p.providerId}`) as StoredProvider | null
  return legacy?.apiKeyRef ?? legacy?.apiKey ?? ''
}

function usable(p: StoredProvider): boolean {
  return !!keyOf(p).trim() && !!(p.baseUrl ?? '').trim()
}

/**
 * 判定卡行，按存储顺序 = 设置屏卡片的排列顺序（客户端保存的就是界面排列序）。
 * 回退链按这个顺序依次尝试；主目标仍是「勾了启用的可用卡优先，其次任意可用卡」。
 */
function jevRows(): StoredProvider[] {
  return providerRows().filter((p) => (p.providerId ? isDecisionProvider(p.providerId) : false))
}

/** 设置屏「判定模型 Provider」页签的回退开关（与 chat 侧 enableProviderFallback 对称）。默认开。 */
export function decisionProviderFallbackEnabled(): boolean {
  const bundle = getSetting('provider_all') as { enableDecisionProviderFallback?: unknown } | null
  return bundle?.enableDecisionProviderFallback !== false
}

/**
 * 当前生效的 Jev 卡：优先「勾了启用且可用（key + baseUrl）」的卡，
 * 其次任意可用卡（保持旧行为：卡上的 enabled 勾选不拦 Jev，Playground 开关才是闸门），
 * 都不可用时退回第一张已配置的卡（供报错与视图展示定位到具体卡）。
 */
function pickJevRow(): StoredProvider | null {
  const rows = jevRows()
  return rows.find((p) => p.enabled && usable(p)) ?? rows.find(usable) ?? rows[0] ?? null
}

function normalize(raw: unknown): JevSettings {
  const value = (raw ?? {}) as Partial<JevSettings>
  const threshold = typeof value.confidenceThreshold === 'number' && Number.isFinite(value.confidenceThreshold)
    ? clampJevThreshold(value.confidenceThreshold)
    : DEFAULT_JEV_SETTINGS.confidenceThreshold
  // 场景阈值逐项校验：老配置（无 scenarioThresholds）补默认值，非法值单项回落而不是整块丢。
  const stored = (value.scenarioThresholds ?? {}) as Partial<Record<JevScenario, number>>
  const scenarioThresholds = {} as Record<JevScenario, number>
  for (const s of JEV_SCENARIOS) {
    const v = stored[s]
    scenarioThresholds[s] = typeof v === 'number' && Number.isFinite(v)
      ? clampJevThreshold(v)
      : DEFAULT_JEV_SCENARIO_THRESHOLDS[s]
  }
  return {
    enabled: value.enabled ?? DEFAULT_JEV_SETTINGS.enabled,
    confidenceThreshold: threshold,
    scenarioThresholds,
    cascadeToChatJudge: value.cascadeToChatJudge ?? DEFAULT_JEV_SETTINGS.cascadeToChatJudge,
    chatJudgeAlways: value.chatJudgeAlways ?? DEFAULT_JEV_SETTINGS.chatJudgeAlways,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  }
}

export function getJevSettings(): JevSettings {
  return normalize(getSetting(SETTINGS_KEY))
}

export function putJevSettings(patch: JevSettingsPatch): JevSettings {
  const current = getJevSettings()
  const next: JevSettings = normalize({
    enabled: patch.enabled ?? current.enabled,
    confidenceThreshold: patch.confidenceThreshold ?? current.confidenceThreshold,
    scenarioThresholds: { ...current.scenarioThresholds, ...(patch.scenarioThresholds ?? {}) },
    cascadeToChatJudge: patch.cascadeToChatJudge ?? current.cascadeToChatJudge,
    chatJudgeAlways: patch.chatJudgeAlways ?? current.chatJudgeAlways,
    updatedAt: new Date().toISOString(),
  })
  putSetting(SETTINGS_KEY, next)
  return next
}

function toJevTarget(pick: StoredProvider): JevTarget {
  const providerId = pick.providerId!
  const model = pick.defaultModelId?.trim() || pick.modelIds?.[0]?.trim()
    || (providerId === JEV_PROVIDER_ID_OPENCODE ? JEV_OPENCODE_DEFAULT_MODEL : JEV_DEFAULT_MODEL)
  return { providerId, baseUrl: (pick.baseUrl ?? '').trim(), apiKey: keyOf(pick).trim(), model }
}

/** Jev 调用目标：两张判定卡（TypeSafe / OpenCode）任一配置可用凭据即可。 */
export function resolveJevTarget(): JevTarget | { error: string } {
  const chain = resolveJevTargets()
  return 'error' in chain ? chain : chain.targets[0]
}

/**
 * 判定模型回退链：主目标在最前，其余可用判定卡按**排列顺序**（存储顺序）垫底。
 * 「启用 Provider 回退」关掉时调用方只该用 targets[0]（见 runJevJudge）。
 */
export function resolveJevTargets(): { targets: JevTarget[] } | { error: string } {
  const rows = jevRows()
  if (rows.length === 0) return { error: `设置屏里找不到 Jev 卡（providerId=${JEV_PROVIDER_IDS.join(' / ')}）` }
  const pick = rows.find((p) => p.enabled && usable(p)) ?? rows.find(usable)
  if (!pick) {
    if (!rows.some((p) => keyOf(p).trim())) {
      return { error: 'Jev 卡缺少 API key（请到 #/settings → LLM Provider → TypeSafe Jev / OpenCode Jev 填写）' }
    }
    return { error: 'Jev 卡缺少 baseUrl（TypeSafe 默认 https://api.typesafe.ai/v1，OpenCode 默认 https://opencode.ai/zen/v1）' }
  }
  // 回退候选 = 其余可用判定卡，保持界面排列顺序（与 chat 侧一致：可用即可回退，enabled 只定主次）。
  const rest = rows.filter((p) => p !== pick && usable(p)).map(toJevTarget)
  return { targets: [toJevTarget(pick), ...rest] }
}

/**
 * 低置信回落的 chat 判定目标：**只从判定模型 Provider 卡里挑**。
 * 判定与回落同源是硬要求：回落不再回落到「大模型 Provider」卡（密钥/配额分流），
 * 想换回落模型就改判定卡（例如把 OpenRouter 大模型卡整卡复制到 OpenCode Jev 卡）。
 *
 * 两种端点协议不同，挑卡时必须分辨：判定卡主调用走 /systemone（判定型号，如
 * jev-1.13-free），回落走 /chat/completions（大模型型号）。判定型号（jev- 命名）
 * 没有 chat 端点，所以一张卡只有当它**带有非判定型号的 LLM** 时才是有效回落目标——
 * TypeSafe 卡只有判定型号，会被跳过；从 OpenCode 大模型卡整卡复制过的 OpenCode Jev
 * 卡带着大模型型号（step-5-preview-free 等），即为回落目标。
 *
 * 卡的主次语义与判定卡一致：勾了启用且可用的优先，其次任意可用卡（enabled 只定主次，
 * 不拦回落）；卡内 LLM 取默认型号（非判定型号时），否则模型回退表里第一个非判定型号。
 */
export function resolveChatJudgeTarget(): { providerId: string; model: string; apiKey: string; baseUrl: string } | null {
  const isChatModel = (m: string | undefined): boolean => !!m?.trim() && !/^jev/i.test(m.trim())
  const rows = jevRows()
  const ordered = [...rows.filter((p) => p.enabled && usable(p)), ...rows.filter((p) => !p.enabled && usable(p))]
  for (const p of ordered) {
    const model =
      (isChatModel(p.defaultModelId) ? p.defaultModelId!.trim() : '') ||
      (p.modelFallbacks ?? []).find(isChatModel)?.trim() ||
      (p.modelIds ?? []).find(isChatModel)?.trim() ||
      ''
    if (!model) continue
    return {
      providerId: p.providerId!,
      model,
      apiKey: keyOf(p).trim(),
      baseUrl: (p.baseUrl ?? '').trim().replace(/\/+$/, ''),
    }
  }
  return null
}

/** UI 视图：密钥一律不回显（B-041），只给 hasKey / 型号 / 端点（跟随当前生效的 Jev 卡）。 */
export function jevSettingsView(): JevSettingsView {
  const settings = getJevSettings()
  const row = pickJevRow()
  const target = resolveJevTarget()
  const chat = resolveChatJudgeTarget()
  return {
    ...settings,
    provider: {
      configured: !('error' in target),
      enabled: !!row?.enabled,
      hasKey: !!keyOf(row ?? {}).trim(),
      baseUrl: (row?.baseUrl ?? '').trim(),
      model: row?.defaultModelId?.trim() || row?.modelIds?.[0]?.trim() || '',
    },
    chatJudge: {
      providerId: chat?.providerId ?? null,
      model: chat?.model ?? null,
    },
  }
}
