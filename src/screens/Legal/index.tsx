import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useI18n, useT } from '../../i18n'
import { ScreenNav } from '../../components/ScreenNav'
import { SourceBadge } from '../MRI'
import {
  ABA_DUTIES,
  CN_FILING_NOTE,
  LEGAL_CONTROLS,
  LEGAL_CONTROL_ENFORCEMENT,
  LEGAL_CONTROL_LABEL,
  type Dossier,
  type LegalBundle,
  type LegalControl,
} from '../../../shared/legal'

export default function Legal() {
  const t = useT()
  const [bundle, setBundle] = useState<LegalBundle | null>(null)
  const [failed, setFailed] = useState(false)
  const [controls, setControls] = useState<Record<LegalControl, boolean>>(() =>
    Object.fromEntries(LEGAL_CONTROLS.map((c) => [c, true])) as Record<LegalControl, boolean>,
  )
  const [route, setRoute] = useState<'cn' | 'us'>('us')
  const [dossierId, setDossierId] = useState('mata-avianca')

  useEffect(() => {
    let live = true
    api.legal()
      .then((b) => { if (live) setBundle(b) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [])

  if (!bundle) {
    return (
      <div className="page">
        <div className="screen-head"><span className="no">LEGAL</span><h1>{t('legal.title')}</h1></div>
        <ScreenNav current="/legal" />
        <div className="panel loading">{failed ? t('legal.error') : t('legal.loading')}</div>
      </div>
    )
  }

  const dossier = bundle.dossiers.find((d) => d.id === dossierId) ?? bundle.dossiers[0]
  const toggle = (c: LegalControl) => setControls((s) => ({ ...s, [c]: !s[c] }))

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">LEGAL</span>
        <h1>{t('legal.title')}</h1>
        <span className="q">{t('legal.subtitle')}</span>
      </div>
      <ScreenNav current="/legal" />

      <div className="grid-tunnel">
        <div>
          <ControlsBoard controls={controls} toggle={toggle} route={route} setRoute={setRoute} />
          <LicenseCard controls={controls} route={route} />
        </div>
        <div>
          <CaseReview dossier={dossier} dossiers={bundle.dossiers} select={setDossierId} />
          <Staircase bundle={bundle} route={route} setRoute={setRoute} />
        </div>
      </div>
    </div>
  )
}

/** F5-1 vertical control board + CN/US route switch. */
function ControlsBoard({ controls, toggle, route, setRoute }: {
  controls: Record<LegalControl, boolean>
  toggle: (c: LegalControl) => void
  route: 'cn' | 'us'
  setRoute: (r: 'cn' | 'us') => void
}) {
  const t = useT()
  return (
    <div className="panel">
      <h3>{t('legal.board.title')} <span className="tag">{t('legal.board.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
        <span className="faint">{t('legal.route')}</span>
        {(['cn', 'us'] as const).map((r) => (
          <button key={r} className={route === r ? 'active-btn' : ''} style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setRoute(r)}>
            {t(`legal.route.${r}`)}
          </button>
        ))}
      </div>
      {LEGAL_CONTROLS.map((c) => {
        const enforced = LEGAL_CONTROL_ENFORCEMENT[c] === 'enforced'
        const on = controls[c]
        return (
          <div className={`comp-row ${on ? 'changed' : ''}`} key={c}>
            <span className="dot" />
            <span className="clabel" title={t(`legal.tip.${c}`)}>{LEGAL_CONTROL_LABEL[c]}</span>
            <span className="faint" style={{ fontSize: 11 }}>{enforced ? t('legal.enforced') : t('legal.guide')}</span>
            <button
              className={on ? 'active-btn' : ''}
              style={{ padding: '1px 10px', fontSize: 12 }}
              onClick={() => toggle(c)}
            >{on ? t('legal.on') : t('legal.off')}</button>
            <div className="comp-ev"><b>{LEGAL_CONTROL_LABEL[c]}</b><br />{t(`legal.tip.${c}`)}</div>
          </div>
        )
      })}
    </div>
  )
}

const ASSERT_COLOR: Record<string, string> = {
  supported: 'var(--green)',
  partially_supported: 'var(--amber)',
  unsupported: 'var(--red)',
  citation_unreachable: 'var(--red)',
  no_citation: 'var(--amber)',
}

/** F5-2 case review: dossier → atomic assertions → ABA report. */
function CaseReview({ dossier, dossiers, select }: { dossier: Dossier; dossiers: Dossier[]; select: (id: string) => void }) {
  const t = useT()
  const flagged = dossier.assertions.filter((a) => a.label !== 'supported')
  const rules = [...new Set(dossier.assertions.flatMap((a) => a.aba ?? []))].sort()
  return (
    <div className="panel">
      <h3>{t('legal.review.title')} <span className="tag">{t('legal.review.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {dossiers.map((d) => (
          <button key={d.id} className={d.id === dossier.id ? 'active-btn' : ''} style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => select(d.id)}>
            {d.title}
          </button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 10 }}>{dossier.memo}</p>
      {dossier.assertions.map((a) => (
        <div key={a.id} style={{ borderLeft: `3px solid ${ASSERT_COLOR[a.label]}`, padding: '6px 10px', margin: '6px 0', background: 'var(--bg-panel2)', borderRadius: '0 8px 8px 0' }}>
          <div style={{ fontSize: 13 }}>{a.text}</div>
          <div style={{ fontSize: 12, marginTop: 2 }}>
            <b style={{ color: ASSERT_COLOR[a.label] }}>{t(`legal.assert.${a.label}`)}</b>
            <span className="faint"> · {a.note}</span>
          </div>
        </div>
      ))}
      <div className="faint" style={{ marginTop: 8 }}>
        {flagged.length === 0
          ? t('legal.review.clean')
          : t('legal.review.flagged', { n: flagged.length, total: dossier.assertions.length })}
      </div>
      <div className="faint" style={{ marginTop: 4 }}>
        {rules.length === 0 ? t('legal.review.aba.none') : t('legal.review.aba', { rules: rules.join(', ') })}
      </div>
    </div>
  )
}

/** F5-3 audit staircase: bare → soft (route) → hard, three curves. */
function Staircase({ bundle, route, setRoute }: { bundle: LegalBundle; route: 'cn' | 'us'; setRoute: (r: 'cn' | 'us') => void }) {
  const t = useT()
  const st = bundle.staircase
  const soft = route === 'cn' ? st.states['soft-cn'] : st.states['soft-us']
  const pts = [st.states.bare, soft, st.states.hard]
  const names = [t('legal.stair.bare'), t('legal.stair.soft'), t('legal.stair.hard')]
  const W = 560
  const H = 190
  const P = 40
  const px = (i: number) => P + (i / 2) * (W - P - 16)
  const py = (v: number) => H - P - (v / 100) * (H - P - 20)
  const line = (f: (s: typeof pts[number]) => number) => pts.map((s, i) => `${px(i)},${py(f(s))}`).join(' ')
  return (
    <div className="panel">
      <h3>{t('legal.stair.title')} <span className="tag">{t('legal.stair.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
        <span className="faint">{t('legal.route')}</span>
        {(['cn', 'us'] as const).map((r) => (
          <button key={r} className={route === r ? 'active-btn' : ''} style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setRoute(r)}>
            {t(`legal.route.${r}`)}
          </button>
        ))}
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }}>
        <line x1={P} y1={H - P} x2={W - 10} y2={H - P} stroke="var(--border-hi)" />
        <line x1={P} y1={14} x2={P} y2={H - P} stroke="var(--border-hi)" />
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={P} y1={py(v)} x2={W - 10} y2={py(v)} stroke="var(--border)" strokeDasharray="3 4" />
            <text x={P - 6} y={py(v) + 3} textAnchor="end" fill="var(--text-faint)" fontSize="10">{v}</text>
          </g>
        ))}
        <polyline fill="none" stroke="var(--red)" strokeWidth="2" points={line((s) => s.fakeCiteRate)} />
        <polyline fill="none" stroke="var(--amber)" strokeWidth="2" points={line((s) => s.ungroundedRate)} />
        <polyline fill="none" stroke="var(--green)" strokeWidth="2" points={line((s) => s.strictPassRate)} />
        {pts.map((s, i) => (
          <g key={i}>
            <circle cx={px(i)} cy={py(s.fakeCiteRate)} r={4} fill="var(--red)" />
            <circle cx={px(i)} cy={py(s.ungroundedRate)} r={4} fill="var(--amber)" />
            <circle cx={px(i)} cy={py(s.strictPassRate)} r={4} fill="var(--green)" />
            <text x={px(i)} y={H - P + 14} textAnchor="middle" fill="var(--text-faint)" fontSize="10">{names[i]}</text>
          </g>
        ))}
      </svg>
      <div style={{ display: 'flex', gap: 14, fontSize: 12, marginTop: 4 }}>
        <span><span style={{ color: 'var(--red)' }}>●</span> {t('legal.stair.fake')}</span>
        <span><span style={{ color: 'var(--amber)' }}>●</span> {t('legal.stair.ungrounded')}</span>
        <span><span style={{ color: 'var(--green)' }}>●</span> {t('legal.stair.strict')}</span>
      </div>
      <div className="faint" style={{ marginTop: 10 }}>{t('legal.stair.refs')}</div>
      {st.references.map((r) => (
        <div key={r.name} style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
          · {r.name}: <b className="mono">{r.value}</b> <span className="faint">({r.citation})</span>
        </div>
      ))}
      <div style={{ marginTop: 6 }}>{st.source.map((s, i) => <span key={i} style={{ marginRight: 6 }}><SourceBadge source={s as never} /></span>)}</div>
    </div>
  )
}

/** F5-4 compliance license card derived from enabled gates. */
function LicenseCard({ controls, route }: { controls: Record<LegalControl, boolean>; route: 'cn' | 'us' }) {
  const t = useT()
  const { lang } = useI18n()
  const rows = ABA_DUTIES.map((d) => ({ ...d, covered: d.gates.every((g) => controls[g]) }))
  const gaps = rows.filter((r) => !r.covered)
  return (
    <div className="panel">
      <h3>{t('legal.license.title')} <span className="tag">{t('legal.license.tag')}</span></h3>
      <table className="t">
        <thead><tr><th>ABA</th><th>{t('legal.license.duty')}</th><th>{t('legal.license.status')}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.rule}>
              <td className="mono">{r.rule}</td>
              <td>{lang === 'zh' ? r.zh : r.en}</td>
              <td style={{ color: r.covered ? 'var(--green)' : 'var(--red)' }}>{r.covered ? t('legal.license.covered') : t('legal.license.gap')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="faint" style={{ marginTop: 8 }}>{t('legal.route')}: {t(`legal.route.${route}`)}</div>
      <div className="faint" style={{ marginTop: 4 }}>
        {gaps.length === 0 ? t('legal.license.none') : `${t('legal.license.residual')}: ${gaps.map((g) => g.rule).join(', ')}`}
      </div>
      <div className="faint" style={{ marginTop: 4 }}>{lang === 'zh' ? CN_FILING_NOTE.zh : CN_FILING_NOTE.en}</div>
    </div>
  )
}
