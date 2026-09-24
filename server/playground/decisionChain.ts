// 判定卡回退链（P0）：四条判定管线（实况三问 / 法律断言 / 失败标签 / RAG 支撑）共用的出网逻辑。
//
// 语义与设置屏「判定模型 Provider」页签的「启用 Provider 回退」开关一致：
//   · 主判定卡失败（HTTP / 断网 / 协议错误）→ 按界面排列顺序切下一张可用判定卡；
//   · 开关关掉 → 只试第一张卡，报错与单卡时代完全一致；
//   · 429/529（官方点名要指数退避）→ 同一张卡先按 1s/2s 退避重试两次；仍限流则该卡进入
//     退避窗口（默认 60s），窗口内直接改用下一张判定卡，不再每条都去撞限流；
//   · 所有卡都在窗口内 → 照常全试（宁可撞限流也不静默不出网）。
// 调参（离线单测也用这两个）：HWT_JEV_BACKOFF_MS 退避基数（默认 1000，0 = 不空等但仍重试）；
//       HWT_JEV_429_COOLDOWN_MS 限流退避窗口（默认 60000，0 = 不进窗口）。
import {
  callSystemOne,
  JevProtocolError,
  type JevQuestionSpec,
  type JevReadings,
  type JevTarget,
} from './jevClient'
import { jevLog } from './jevLog'
import { decisionProviderFallbackEnabled, resolveJevTargets } from './jevSettings'

/** 同一张卡 429/529 最多退避重试次数（1s、2s 各一次，之后换下一张卡）。 */
const MAX_BACKOFF_RETRIES = 2

export interface DecisionCallOk {
  ok: true
  readings: JevReadings
  latencyMs: number
  usage: { inputTokens: number; outputTokens: number } | null
  responseModel: string | null
  /** 实际应答的判定卡（发生回退后与链头不同，记账以它为准）。 */
  target: JevTarget
}

export interface DecisionCallErr {
  ok: false
  /** setup = 设置屏的判定卡链路本身不可用；call = 出网调用整条链都失败。 */
  stage: 'setup' | 'call'
  error: string
  /** 最后失败那张卡的型号（setup 失败为 null），落进 error 徽标好定位到卡。 */
  model: string | null
  latencyMs: number | null
}

export type DecisionCallResult = DecisionCallOk | DecisionCallErr

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? '')
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 官方点名要指数退避的两个状态码；按 status 判，不靠错误文案猜。 */
function rateLimited(err: unknown): boolean {
  return err instanceof JevProtocolError && (err.status === 429 || err.status === 529)
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/** 限流退避窗口：key = providerId/model → 解除时间戳。 */
const backoffWindow = new Map<string, number>()

function cardKey(target: JevTarget): string {
  return `${target.providerId}/${target.model}`
}

function inBackoffWindow(target: JevTarget): boolean {
  const key = cardKey(target)
  const until = backoffWindow.get(key)
  if (until == null) return false
  if (Date.now() >= until) {
    backoffWindow.delete(key)
    return false
  }
  return true
}

function enterBackoffWindow(target: JevTarget): number {
  const ms = envMs('HWT_JEV_429_COOLDOWN_MS', 60_000)
  if (ms > 0) backoffWindow.set(cardKey(target), Date.now() + ms)
  return ms
}

/** 清空限流退避窗口（离线单测用：窗口是内存态，避免用例之间互相跳卡）。 */
export function clearDecisionBackoff(): void {
  backoffWindow.clear()
}

/**
 * 一次判定出网：按设置屏的判定卡链路依次尝试，直到某张卡给出读数或整条链失败。
 * 永不抛错——失败以 stage/error 落给调用方，由调用方决定记成 error 徽标还是转人。
 */
export async function callDecisionChain(
  state: string,
  questions: Record<string, JevQuestionSpec>,
): Promise<DecisionCallResult> {
  const started = Date.now()
  const chain = resolveJevTargets()
  if ('error' in chain) {
    return { ok: false, stage: 'setup', error: chain.error, model: null, latencyMs: null }
  }

  const fallbackOn = decisionProviderFallbackEnabled()
  let candidates = fallbackOn ? chain.targets : chain.targets.slice(0, 1)
  // 429 退避窗口内的卡直接跳过；开关关掉时只有首卡，跳过就没卡可打了，不跳。
  const skipped: string[] = []
  if (fallbackOn) {
    const live = candidates.filter((t) => !inBackoffWindow(t))
    if (live.length > 0) {
      for (const t of candidates) if (!live.includes(t)) skipped.push(cardKey(t))
      candidates = live
    }
  }

  const backoffBase = envMs('HWT_JEV_BACKOFF_MS', 1000)
  const failures: string[] = []
  for (let i = 0; i < candidates.length; i++) {
    const card = candidates[i]
    for (let attempt = 0; ; attempt++) {
      try {
        const call = await callSystemOne(card, state, questions)
        if (failures.length > 0) {
          jevLog(`provider fallback ok ← ${card.providerId}/${card.model}（前序判定卡失败：${failures.join('；')}）`)
        } else if (skipped.length > 0) {
          jevLog(`provider fallback ok ← ${card.providerId}/${card.model}（跳过 429 退避窗口中的 ${skipped.join('、')}）`)
        }
        return {
          ok: true,
          readings: call.readings,
          latencyMs: call.latencyMs,
          usage: call.usage,
          responseModel: call.responseModel,
          target: card,
        }
      } catch (err) {
        const message = describe(err)
        if (rateLimited(err) && attempt < MAX_BACKOFF_RETRIES) {
          const wait = backoffBase * 2 ** attempt
          jevLog(
            `backoff retry ← ${card.providerId}/${card.model} 限流退避 ${wait}ms 后重试（第 ${attempt + 1}/${MAX_BACKOFF_RETRIES} 次）：${message}`,
          )
          await sleep(wait)
          continue
        }
        // 这张卡到头了：限流的进退避窗口，随后按排列顺序换下一张。
        if (rateLimited(err)) {
          const windowMs = enterBackoffWindow(card)
          jevLog(`backoff window ← ${card.providerId}/${card.model} 限流，${windowMs}ms 内改用下一张判定卡`)
        }
        const hadPrior = failures.length > 0
        failures.push(`${card.providerId}/${card.model}: ${message}`)
        const isLast = i === candidates.length - 1
        if (isLast || !fallbackOn) {
          const skippedNote = skipped.length > 0 ? `；另 ${skipped.join('、')} 因 429 退避窗口未参与本次调用` : ''
          const error = hadPrior ? `所有判定卡均失败：${failures.join('；')}${skippedNote}` : `${message}${skippedNote}`
          return { ok: false, stage: 'call', error, model: card.model, latencyMs: Date.now() - started }
        }
        jevLog(`provider fallback ← 第 ${i + 1} 张判定卡失败，按排列顺序切下一张（链长 ${candidates.length}）`)
        break
      }
    }
  }
  // 防御：链非空，每张卡要么给出读数要么返回错误，正常到不了这里。
  return { ok: false, stage: 'call', error: 'Jev 未产生读数', model: null, latencyMs: Date.now() - started }
}
