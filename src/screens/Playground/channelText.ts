// One-line renderings of the four scoring channels, shared by the run detail and
// the per-question scorecard so the two can never describe the same reading
// differently.
import {
  readingAgreesWithVerdict,
  type JevChatJudgeReading,
  type JevJudgeResult,
} from '../../../shared/jev'

/** A 0–1 confidence; null means the model reported none. */
export function fmtConf(n: number | null | undefined): string {
  return n == null ? '—' : n.toFixed(2)
}

/** Jev's own readings, verbatim — the basis for whatever it concluded. */
export function jevReadingLine(r: JevJudgeResult): string {
  const bits: string[] = []
  if (r.choice) bits.push(`choice=${r.choice.choice} (conf ${fmtConf(r.choice.confidence)})`)
  if (r.score) bits.push(`score=${r.score.score} (conf ${fmtConf(r.score.confidence)})`)
  if (r.grounded) bits.push(`noul=${fmtConf(r.grounded.noul)}`)
  return bits.length > 0 ? bits.join(' · ') : '—'
}

/** The chat model's own reading, used when Jev's confidence was too low to stand on. */
export function llmReadingLine(c: JevChatJudgeReading): string {
  const bits = [`choice=${c.choice} (conf ${fmtConf(c.confidence)})`, c.model]
  if (c.reason) bits.push(c.reason)
  return bits.filter(Boolean).join(' · ')
}

/** i18n key for how a reading lines up with the deterministic verdict; '' when unscored. */
export function agreementKey(choice: string | null, detSuccess: boolean | null): string {
  if (detSuccess == null) return ''
  const agrees = readingAgreesWithVerdict(choice, detSuccess)
  if (agrees == null) return 'playground.live.agree.incomparable'
  return agrees ? 'playground.live.agree.consistent' : 'playground.live.agree.divergent'
}
