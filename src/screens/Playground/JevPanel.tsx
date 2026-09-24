import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import {
  type JevJudgeResult,
  type JevSource,
} from '../../../shared/jev'

const SOURCE_CLASS: Record<JevSource, string> = {
  'jev-live': 'src-badge src-live',
  'llm-judge': 'src-badge src-paper',
  'needs-human': 'src-badge src-fixture',
  bypass: 'src-badge src-fixture',
  off: 'src-badge src-fixture',
  error: 'src-badge src-fixture',
}

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`
}

function probList(probs: Record<string, number> | null): string {
  if (!probs) return '—'
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
    .join(' · ')
}

/** Score 档位用官方 legend 标中文（键为 0 起编号，回映射到我们送的 1–5 分描述）。 */
function scoreProbList(score: { probabilities: Record<string, number> | null; legend: Record<string, string> | null }): string {
  const probs = score.probabilities
  if (!probs) return '—'
  const label = (k: string): string => {
    const text = score.legend?.[k]
    if (!text) return k
    const head = text.split('——')[0] ?? text
    return head.length > 16 ? `${head.slice(0, 16)}…` : head
  }
  return Object.entries(probs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${label(k)} ${(v * 100).toFixed(0)}%`)
    .join(' · ')
}

/** 判分自检台置顶的旁路复核块：Jev 三个读数 + 级联去向 + 与确定性判分的一致性。 */
export function JevJudgeBlock({
  enabled,
  busy,
  result,
  error,
  onRun,
  children,
}: {
  enabled: boolean
  busy: boolean
  result: JevJudgeResult | null
  error: string | null
  onRun: () => void
  /** 额外的行内控件（例如启用勾选框），与标题同排。 */
  children?: ReactNode
}) {
  const t = useT()
  return (
    <div style={{ marginBottom: 12, borderBottom: '1px dashed var(--border)', paddingBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <b style={{ fontSize: 12 }}>{t('playground.jev.title')}</b>
        {children}
        <span style={{ flex: 1 }} />
        <button
          className={enabled ? 'primary' : ''}
          style={{ fontSize: 12, padding: '3px 12px' }}
          onClick={onRun}
          disabled={busy || !enabled}
        >
          {busy ? t('playground.jev.running') : t('playground.jev.run')}
        </button>
      </div>

      {error && <div style={{ color: 'var(--red, #c06a6a)', fontSize: 12, marginTop: 6 }}>{error}</div>}

      {result && (
        <div className="panel" style={{ margin: '8px 0 0', padding: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className={SOURCE_CLASS[result.source]}>{t(`playground.jev.source.${result.source}`)}</span>
            {result.model && <span className="faint mono">{result.model}</span>}
            {result.latencyMs != null && (
              <span className="faint">{t('playground.jev.latency', { sec: (result.latencyMs / 1000).toFixed(2) })}</span>
            )}
            <span className="faint">
              {result.usage
                ? t('playground.jev.stateMetaReal', { chars: result.stateChars, tokens: result.usage.inputTokens })
                : t('playground.jev.stateMeta', { chars: result.stateChars, tokens: result.estimatedPromptTokens })}
            </span>
          </div>

          <div className="faint" style={{ marginTop: 6 }}>{result.reason}</div>

          <div style={{ display: 'grid', gap: 6, marginTop: 8, fontSize: 12 }}>
            <div>
              <b>{t('playground.jev.choice')}</b>
              {result.choice ? (
                <>
                  {t(`playground.jev.choice.${result.choice.choice}`)}
                  {t('playground.jev.confidence', { pct: pct(result.choice.confidence) })}
                  <span className="faint">{t('playground.jev.probs', { list: probList(result.choice.probabilities) })}</span>
                </>
              ) : (
                <span className="faint">{t('playground.jev.noReading')}</span>
              )}
            </div>
            <div>
              <b>{t('playground.jev.score')}</b>
              {result.score ? (
                <>
                  {result.score.score.toFixed(1)}
                  {t('playground.jev.confidence', { pct: pct(result.score.confidence) })}
                  <span className="faint">{t('playground.jev.probs', { list: scoreProbList(result.score) })}</span>
                </>
              ) : (
                <span className="faint">{t('playground.jev.noReading')}</span>
              )}
            </div>
            <div>
              <b>{t('playground.jev.grounded')}</b>
              {result.grounded ? (
                <>{t('playground.jev.groundedNote', { pct: `${Math.round(result.grounded.noul * 100)}%` })}</>
              ) : (
                <span className="faint">{t('playground.jev.noReading')}</span>
              )}
            </div>
            <div>
              <b>{t('playground.jev.vsDeterministic')}</b>
              {result.consistency === 'consistent'
                ? t('playground.jev.consistent')
                : result.consistency === 'divergent'
                  ? t('playground.jev.divergent')
                  : t('playground.jev.incomparable')}
              <span className="faint"> · {result.consistencyDetail}</span>
            </div>
            {result.chatJudge && (
              <div>
                <b>{t('playground.jev.fallback', { model: result.chatJudge.model })}</b>
                {t(`playground.jev.choice.${result.chatJudge.choice}`)}
                <span className="faint">
                  {t('playground.jev.confidence', { pct: pct(result.chatJudge.confidence) })}·{' '}
                  {result.chatJudge.reason || t('playground.jev.noReason')} ·{' '}
                  {result.chatJudge.promptTokens}+{result.chatJudge.completionTokens} tok
                </span>
              </div>
            )}
          </div>

          {result.securityBypass && (
            <div className="faint" style={{ marginTop: 8, color: 'var(--amber, #b7791f)' }}>
              {t('playground.jev.securityBypass')}
              {result.stateSharesInjectedPayload && t('playground.jev.injectedPayload')}
            </div>
          )}
          {result.stateTruncated && (
            <div className="faint" style={{ marginTop: 6, color: 'var(--amber, #b7791f)' }}>
              {t('playground.jev.truncated')}
            </div>
          )}

        </div>
      )}
    </div>
  )
}

