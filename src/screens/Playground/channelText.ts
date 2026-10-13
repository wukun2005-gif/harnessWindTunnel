// One-line renderings of the decision-model readings, shared by the run detail
// and the per-question scorecard so the two can never describe the same reading
// differently.
//
// 用户口径（写死在这里，界面两处共用）：**判定读数一律呈现判定模型（mercury）的**，
// 旧判分器（jev-1.13.0）的读数在 app 里不再对外呈现。
import { type JevJudgeResult } from '../../../shared/jev'

/** A 0–1 confidence; null means the model reported none. */
export function fmtConf(n: number | null | undefined): string {
  return n == null ? '—' : n.toFixed(2)
}

/** 判定卡上配的型号别名（会漂移）。判定时应答报的型号是 `…-20260930` 这种带日期的。 */
export const UI_JUDGE_MODEL = 'inception/mercury-decide:free'
const UI_JUDGE_MODEL_PREFIX = 'inception/mercury-decide'

export function isUiJudgeModel(model: string | null | undefined): boolean {
  return (model ?? '').startsWith(UI_JUDGE_MODEL_PREFIX)
}

/** 界面上呈现的判定读数：只装 mercury 实际采到的原语，缺的就不装，不补 0 也不补 '—'。 */
export interface UiJudgeReading {
  model: string
  latencyMs: number | null
  choice: string | null
  choiceConfidence: number | null
  agreement: number | null
  agreementConfidence: number | null
  noul: number | null
}

/**
 * 取要呈现的 mercury 读数：
 *   1. 主槽（`choice`/`agreement`/`grounded`）——判分时真正定分的那次读数，三原语齐全；
 *   2. 老 run 的侧槽 `altChoices`：2026-10-12 那轮 mercury 评测只问了 Choice，留着 choice
 *      一条 —— 回填覆盖主槽之前，界面仍能显示 mercury 的读数，而不是空的或旧判分器的。
 * 主槽是旧判分器、侧槽又没有 mercury 的情况返回 null（界面显示"不再呈现"）。
 */
export function pickUiJudgeReading(jv: JevJudgeResult | null | undefined): UiJudgeReading | null {
  if (!jv) return null
  if (isUiJudgeModel(jv.model) && (jv.choice || jv.agreement || jv.grounded)) {
    return {
      model: jv.model ?? UI_JUDGE_MODEL,
      latencyMs: jv.latencyMs ?? null,
      choice: jv.choice?.choice ?? null,
      choiceConfidence: jv.choice?.confidence ?? null,
      agreement: jv.agreement?.score ?? null,
      agreementConfidence: jv.agreement?.confidence ?? null,
      noul: jv.grounded?.noul ?? null,
    }
  }
  for (const [model, r] of Object.entries(jv.altChoices ?? {})) {
    if (!isUiJudgeModel(model) || !r?.choice) continue
    return {
      model,
      latencyMs: r.latencyMs ?? null,
      choice: r.choice,
      choiceConfidence: r.confidence ?? null,
      agreement: null,
      agreementConfidence: null,
      noul: null,
    }
  }
  return null
}

/** 判定读数的单行渲染，逐项原样回显 —— 它给出结论的依据。 */
export function uiJudgeReadingLine(r: UiJudgeReading): string {
  const bits: string[] = []
  if (r.choice) bits.push(`choice=${r.choice} (conf ${fmtConf(r.choiceConfidence)})`)
  if (r.agreement != null) bits.push(`score=${r.agreement} (conf ${fmtConf(r.agreementConfidence)})`)
  if (r.noul != null) bits.push(`noul=${fmtConf(r.noul)}`)
  return bits.length > 0 ? bits.join(' · ') : '—'
}
