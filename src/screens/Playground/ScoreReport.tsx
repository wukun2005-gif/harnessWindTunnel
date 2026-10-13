import type { ScoreResult } from '../../../shared/playground'
import { MAST_LABEL } from '../../../shared/mast'
import { useFixture, useT } from '../../i18n'

export function ScoreReport({ result }: { result: ScoreResult }) {
  const t = useT()
  const fx = useFixture()
  // Extra-credit points are listed but never counted: the header must agree with
  // `score`/`success`, which only look at what the question actually asked.
  const requiredFacts = result.factChecks.filter((c) => c.required)
  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: 10,
          borderRadius: 6,
          marginBottom: 10,
          background: result.success ? 'rgba(80,180,120,0.12)' : 'rgba(200,90,90,0.12)',
        }}
      >
        <strong style={{ fontSize: 18 }}>{result.success ? t('playground.report.pass') : t('playground.report.fail')}</strong>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 16 }}>score {result.score.toFixed(2)}</span>
        <span className="faint" style={{ fontSize: 12 }}>
          {result.summary}
        </span>
      </div>

      {result.failureTags.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <b style={{ fontSize: 12 }}>{t('playground.report.failureTags')}</b>
          <div style={{ marginTop: 4 }}>
            {result.failureTags.map((tag) => (
              <span
                key={tag}
                title={fx(MAST_LABEL[tag])}
                style={{
                  display: 'inline-block',
                  margin: '0 6px 6px 0',
                  padding: '2px 8px',
                  borderRadius: 10,
                  fontSize: 11,
                  fontFamily: 'var(--mono)',
                  background: 'rgba(200,90,90,0.15)',
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {result.antiHallucination && (
        <Check title={t('playground.report.antiHallucination')} ok={result.antiHallucination.recognized} detail={result.antiHallucination.detail} />
      )}

      {result.securityChecks.map((c, i) => (
        <Check key={i} title={t('playground.report.securityGate', { kind: c.kind })} ok={c.passed} detail={`${c.detail}${c.hits.length ? `（${c.hits.join('、')}）` : ''}`} />
      ))}

      {result.factChecks.length > 0 && (
        <Section title={t('playground.report.goldHits', { hit: requiredFacts.filter((c) => c.hit).length, total: requiredFacts.length })}>
          {/* Point / result / what was missing — a bare pass-fail tells you nothing
              about which point failed, so the detail is the whole point of this list. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 28px minmax(0,1.1fr)', columnGap: 8, rowGap: 3 }}>
            {result.factChecks.map((c) => (
              <Row
                key={c.id}
                ok={c.hit}
                bonus={!c.required}
                label={c.label}
                sub={!c.hit && c.required ? c.missingTerms.join(' / ') : undefined}
              />
            ))}
          </div>
        </Section>
      )}

      {result.articleChecks.length > 0 && (
        <Section title={t('playground.report.articles')}>
          {result.articleChecks.map((c) => (
            <div key={c.id} style={{ margin: '8px 0', padding: 8, border: '1px solid var(--dim)', borderRadius: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{c.assertion === 'supported' ? '✓' : '✗'}</span>
                <b style={{ fontSize: 12, flex: 1 }}>{c.label}</b>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--mono)',
                    padding: '1px 8px',
                    borderRadius: 10,
                    background:
                      c.assertion === 'supported'
                        ? 'rgba(80,180,120,0.15)'
                        : c.assertion === 'partially_supported'
                          ? 'rgba(200,170,60,0.18)'
                          : 'rgba(200,90,90,0.15)',
                  }}
                >
                  {t(`legal.assert.${c.assertion}`)}
                </span>
              </div>
              <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>
                {c.detail}
              </div>
              {c.articleSnippet && (
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: 'var(--mono)',
                    marginTop: 6,
                    padding: 6,
                    background: 'var(--dim)',
                    borderRadius: 4,
                    maxHeight: 90,
                    overflow: 'auto',
                  }}
                >
                  {t('playground.report.snippet', { snippet: c.articleSnippet })}
                </div>
              )}
            </div>
          ))}
        </Section>
      )}
    </div>
  )
}

export function Check({ title, ok, detail }: { title: string; ok: boolean; detail: string }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '8px 10px',
        marginBottom: 6,
        borderRadius: 6,
        background: ok ? 'rgba(80,180,120,0.08)' : 'rgba(200,90,90,0.10)',
      }}
    >
      <span>{ok ? '✓' : '✗'}</span>
      <div>
        <b style={{ fontSize: 12 }}>{title}</b>
        <div className="faint" style={{ fontSize: 11 }}>
          {detail}
        </div>
      </div>
    </div>
  )
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 10 }}>
      <b style={{ fontSize: 12 }}>{title}</b>
      <div style={{ marginTop: 4 }}>{children}</div>
    </div>
  )
}

/** One grid row: point / result / what was missing. `display: contents` lets the
 *  caller own the columns, so the list lines up as a table. */
export function Row({ ok, label, sub, bonus }: { ok: boolean; label: string; sub?: string; bonus?: boolean }) {
  const t = useT()
  return (
    <div className={bonus ? 'faint' : undefined} style={{ display: 'contents' }}>
      <span style={{ fontSize: 12 }}>
        {label}
        {/* Extra credit is not a pass/fail: a missed one is not a ✗, it is simply absent. */}
        {bonus && <span style={{ fontSize: 11 }}> {t('playground.report.bonus')}</span>}
      </span>
      <span style={{ fontSize: 12, textAlign: 'center' }}>{bonus ? (ok ? '+' : '·') : ok ? '✓' : '✗'}</span>
      <span className="faint" style={{ fontSize: 11 }}>{sub ?? ''}</span>
    </div>
  )
}
