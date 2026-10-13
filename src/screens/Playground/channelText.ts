// One-line renderings of the decision-model readings, shared by the run detail
// and the per-question scorecard so the two can never describe the same reading
// differently.
//
// 2026-10-12 重构后只有一条判分通道：判定模型。原先的「确定性 / Jev / 回落 LLM」
// 三通道并排展示与 agreementKey 都随之删除。
import { type JevJudgeResult } from '../../../shared/jev'

/** A 0–1 confidence; null means the model reported none. */
export function fmtConf(n: number | null | undefined): string {
  return n == null ? '—' : n.toFixed(2)
}

/**
 * 判定读数的单行渲染 —— 这条 run 的判分方读数，取自主槽
 * （`choice` / `agreement` / `grounded`）。
 *
 * 早期界面一度只读 `altChoices`（判分器横向评测留下的侧槽，服务端已不再写入），
 * 结果读数明明已经落库、每条 run 却都显示"判定模型开关是关的"。现固定读主槽：
 * 主槽里就是这条 run 真正定分的那次读数。
 */
export function jevReadingLine(r: JevJudgeResult): string {
  const bits: string[] = []
  if (r.choice) bits.push(`choice=${r.choice.choice} (conf ${fmtConf(r.choice.confidence)})`)
  if (r.agreement) bits.push(`score=${r.agreement.score} (conf ${fmtConf(r.agreement.confidence)})`)
  if (r.grounded) bits.push(`noul=${fmtConf(r.grounded.noul)}`)
  return bits.length > 0 ? bits.join(' · ') : '—'
}
