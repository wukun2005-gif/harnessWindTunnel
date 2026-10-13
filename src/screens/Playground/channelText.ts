// One-line renderings of the decision-model readings, shared by the run detail
// and the per-question scorecard so the two can never describe the same reading
// differently.
//
// 2026-10-12 重构后只有一条判分通道：判定模型。原先的「确定性 / Jev / 回落 LLM」
// 三通道并排展示与 agreementKey 都随之删除。
import { type JevAltChoiceReading, type JevJudgeResult } from '../../../shared/jev'

/** A 0–1 confidence; null means the model reported none. */
export function fmtConf(n: number | null | undefined): string {
  return n == null ? '—' : n.toFixed(2)
}

/**
 * 界面呈现的判定读数来自哪个模型。
 *
 * 用户口径：**这批 run 的判分方是 `inception/mercury-decide:free`**，界面上旧读数一律
 * 不再显示。mercury 的读数落在 `jevResult.altChoices`（按型号独立成键的槽位）——
 * 那是**数据落库的位置**，不代表"它只是备选"。
 *
 * 主槽 `choice`/`model`/`source` 里残留的旧读数**不对外呈现**：同一个 run 的「判定方」
 * 在报告和界面上必须是同一台模型。
 *
 * 优先取该型号；没有就退回该 run 上任意一个备选读数 —— 换判定模型时界面不用跟着改代码，
 * 也不会退回去显示旧读数。
 */
export const UI_JUDGE_MODEL = 'inception/mercury-decide:free'

export function pickJudgeReading(
  jv: JevJudgeResult | null | undefined,
): { model: string; reading: JevAltChoiceReading } | null {
  const entries = Object.entries(jv?.altChoices ?? {})
  if (entries.length === 0) return null
  const [model, reading] = entries.find(([m]) => m === UI_JUDGE_MODEL) ?? entries[0]!
  return { model, reading }
}

/**
 * 判定读数的单行渲染（主槽形态：`choice` / `agreement` / `grounded`）。
 * 保留给非界面消费方；界面一律走 `altReadingLine`。
 */
export function jevReadingLine(r: JevJudgeResult): string {
  const bits: string[] = []
  if (r.choice) bits.push(`choice=${r.choice.choice} (conf ${fmtConf(r.choice.confidence)})`)
  if (r.agreement) bits.push(`score=${r.agreement.score} (conf ${fmtConf(r.agreement.confidence)})`)
  if (r.grounded) bits.push(`noul=${fmtConf(r.grounded.noul)}`)
  return bits.length > 0 ? bits.join(' · ') : '—'
}

/**
 * 备选读数（`altChoices` 里的形态）的单行渲染，与主读数同格式。
 *
 * 只渲染该模型**实际采到**的原语：这轮判定模型评测只问了 Choice 原语，所以 mercury 的
 * 读数里没有 score / noul —— 这里不会凭空补 0 或 '—' 去伪装成"采到了"。
 */
export function altReadingLine(r: JevAltChoiceReading): string {
  const bits: string[] = []
  if (r.choice) bits.push(`choice=${r.choice} (conf ${fmtConf(r.confidence)})`)
  return bits.length > 0 ? bits.join(' · ') : '—'
}
