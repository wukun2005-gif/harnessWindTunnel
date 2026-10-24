import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useI18n, useT, useFixture } from '../../i18n'
import { SourceBadge } from '../MRI'
import { ReadGuide } from '../../components/ReadGuide'
import {
  ABA_DUTIES,
  CN_FILING_NOTE,
  LEGAL_CONTROLS,
  LEGAL_CONTROL_ENFORCEMENT,
  STAIRCASE_GLOBAL_REF,
  type Dossier,
  type DossierAssertion,
  type LegalAssertion,
  type LegalBundle,
  type LegalControl,
} from '../../../shared/legal'

/**
 * What each control can actually catch. A switch that changes no assertion is
 * not a legal safeguard the audience can evaluate, so the board states its
 * remit next to the toggle. `hash-audit-chain` catches nothing substantive —
 * it only makes edits detectable, and says so.
 */
const CONTROL_BLOCKS: Record<LegalControl, LegalAssertion[]> = {
  'authority-mcp': ['citation_unreachable'],
  'citation-audit': ['citation_unreachable', 'no_citation'],
  'deadline-ledger': ['unsupported'],
  'jurisdiction-filter': ['unsupported'],
  'issue-close-gate': ['unsupported', 'partially_supported', 'no_citation', 'citation_unreachable'],
  'risk-escalation-gate': ['partially_supported'],
  'hash-audit-chain': [],
}

interface Catchers {
  enforced: LegalControl[]
  guides: LegalControl[]
}

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
        <div className="screen-head"><span className="no">{t('legal.eyebrow')}</span><h1>{t('legal.title')}</h1></div>
        <div className="panel loading">{failed ? t('legal.error') : t('legal.loading')}</div>
      </div>
    )
  }

  const dossier = bundle.dossiers.find((d) => d.id === dossierId) ?? bundle.dossiers[0]
  const toggle = (c: LegalControl) => setControls((s) => ({ ...s, [c]: !s[c] }))
  const setAll = (mode: 'bare' | 'gated' | 'enforced') => setControls(() => Object.fromEntries(LEGAL_CONTROLS.map((c) => {
    const enforced = LEGAL_CONTROL_ENFORCEMENT[c] === 'enforced'
    return [c, mode === 'bare' ? false : mode === 'enforced' ? enforced : true]
  })) as Record<LegalControl, boolean>)

  const catchersFor = (a: DossierAssertion): Catchers => {
    const on = LEGAL_CONTROLS.filter((c) => controls[c] && CONTROL_BLOCKS[c].includes(a.label))
    return {
      enforced: on.filter((c) => LEGAL_CONTROL_ENFORCEMENT[c] === 'enforced'),
      guides: on.filter((c) => LEGAL_CONTROL_ENFORCEMENT[c] === 'guide'),
    }
  }
  const flagged = dossier.assertions.filter((a) => a.label !== 'supported')
  const caught = flagged.filter((a) => catchersFor(a).enforced.length > 0)
  const residual = flagged.filter((a) => catchersFor(a).enforced.length === 0)
  const residualTypes = [...new Set(residual.map((a) => a.label))]
  const enforcedOn = LEGAL_CONTROLS.filter((c) => controls[c] && LEGAL_CONTROL_ENFORCEMENT[c] === 'enforced').length
  const guidesOn = LEGAL_CONTROLS.filter((c) => controls[c] && LEGAL_CONTROL_ENFORCEMENT[c] === 'guide').length

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">{t('legal.eyebrow')}</span>
        <h1>{t('legal.title')}</h1>
        <span className="q">{t('legal.subtitle')}</span>
      </div>

      <ReadGuide keys={['guide.legal.1', 'guide.legal.2', 'guide.legal.3']} />

      <div className="grid-tunnel">
        <div>
          <ControlsBoard controls={controls} toggle={toggle} setAll={setAll} enforcedOn={enforcedOn} guidesOn={guidesOn} route={route} setRoute={setRoute} />
          <LicenseCard controls={controls} route={route} residual={residual.length} residualTypes={residualTypes} enforcedOn={enforcedOn} />
        </div>
        <div>
          <CaseReview
            dossier={dossier}
            dossiers={bundle.dossiers}
            select={setDossierId}
            catchersFor={catchersFor}
            caught={caught.length}
            residual={residual.length}
            enforcedOn={enforcedOn}
            guidesOn={guidesOn}
          />
          <Staircase bundle={bundle} dossierRefs={dossier.refs} route={route} />
        </div>
      </div>
    </div>
  )
}

/** F5-1 vertical control board + CN/US route switch. */
function ControlsBoard({ controls, toggle, setAll, enforcedOn, guidesOn, route, setRoute }: {
  controls: Record<LegalControl, boolean>
  toggle: (c: LegalControl) => void
  setAll: (mode: 'bare' | 'gated' | 'enforced') => void
  enforcedOn: number
  guidesOn: number
  route: 'cn' | 'us'
  setRoute: (r: 'cn' | 'us') => void
}) {
  const t = useT()
  const groups: Array<{ mode: 'enforced' | 'guide'; items: LegalControl[] }> = [
    { mode: 'enforced', items: LEGAL_CONTROLS.filter((c) => LEGAL_CONTROL_ENFORCEMENT[c] === 'enforced') },
    { mode: 'guide', items: LEGAL_CONTROLS.filter((c) => LEGAL_CONTROL_ENFORCEMENT[c] === 'guide') },
  ]
  return (
    <div className="panel">
      <h3>{t('legal.board.title')} <span className="tag">{t('legal.board.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="faint">{t('legal.route')}</span>
        {(['cn', 'us'] as const).map((r) => (
          <button key={r} className={route === r ? 'active-btn' : ''} style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => setRoute(r)}>
            {t(`legal.route.${r}`)}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <button style={{ padding: '2px 9px', fontSize: 11.5 }} onClick={() => setAll('bare')}>{t('legal.preset.bare')}</button>
        <button style={{ padding: '2px 9px', fontSize: 11.5 }} onClick={() => setAll('gated')}>{t('legal.preset.gated')}</button>
        <button style={{ padding: '2px 9px', fontSize: 11.5 }} onClick={() => setAll('enforced')}>{t('legal.preset.enforcedOnly')}</button>
      </div>
      <div className="faint" style={{ marginBottom: 8 }}>{t('legal.review.mode', { enforced: enforcedOn, guides: guidesOn })}</div>
      {groups.map((group) => (
        <div key={group.mode} style={{ marginBottom: group.mode === 'enforced' ? 10 : 0 }}>
          <div className="faint" style={{ margin: '4px 0 5px', letterSpacing: '.03em' }}>
            {group.mode === 'enforced'
              ? t('legal.group.enforced', { count: group.items.length })
              : t('legal.group.guide', { count: group.items.length })}
          </div>
          {group.items.map((c) => {
            const on = controls[c]
            const blocks = CONTROL_BLOCKS[c]
            return (
              <div className={`comp-row ${on ? 'changed' : ''}`} key={c}>
                <span className="dot" />
                <span className="clabel" title={t(`legal.tip.${c}`)} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span>{t(`legal.control.${c}`)}</span>
                  <span className="faint" style={{ fontSize: 10.5, whiteSpace: 'normal' }}>
                    {t('legal.blocks')}: {blocks.length === 0 ? t('legal.blocks.none') : blocks.map((b) => t(`legal.assert.${b}`)).join(' / ')}
                  </span>
                </span>
                <button
                  className={on ? 'active-btn' : ''}
                  style={{ padding: '1px 10px', fontSize: 12 }}
                  onClick={() => toggle(c)}
                >{on ? t('legal.on') : t('legal.off')}</button>
                <div className="comp-ev"><b>{t(`legal.control.${c}`)}</b><br />{t(`legal.tip.${c}`)}</div>
              </div>
            )
          })}
        </div>
      ))}
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
function CaseReview({ dossier, dossiers, select, catchersFor, caught, residual, enforcedOn, guidesOn }: {
  dossier: Dossier
  dossiers: Dossier[]
  select: (id: string) => void
  catchersFor: (a: DossierAssertion) => Catchers
  caught: number
  residual: number
  enforcedOn: number
  guidesOn: number
}) {
  const t = useT()
  const f = useFixture()
  const flagged = dossier.assertions.filter((a) => a.label !== 'supported')
  const rules = [...new Set(dossier.assertions.flatMap((a) => a.aba ?? []))].sort()
  return (
    <div className="panel" data-demo="case">
      <h3>{t('legal.review.title')} <span className="tag">{t('legal.review.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {dossiers.map((d) => (
          <button key={d.id} className={d.id === dossier.id ? 'active-btn' : ''} style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => select(d.id)}>
            {f(d.title)}
          </button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 13, marginBottom: 6 }}>{f(dossier.memo)}</p>
      <div className="faint" style={{ marginBottom: 10 }}>{t('legal.review.mode', { enforced: enforcedOn, guides: guidesOn })}</div>
      {dossier.assertions.map((a) => {
        const hit = catchersFor(a)
        const blocked = hit.enforced.length > 0
        const guideOnly = !blocked && hit.guides.length > 0
        return (
          <div key={a.id} style={{ borderLeft: `3px solid ${ASSERT_COLOR[a.label]}`, padding: '6px 10px', margin: '6px 0', background: 'var(--bg-panel2)', borderRadius: '0 8px 8px 0' }}>
            <div style={{ fontSize: 13 }}>{f(a.text)}</div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              <b style={{ color: ASSERT_COLOR[a.label] }}>{t(`legal.assert.${a.label}`)}</b>
              <span className="faint"> · {f(a.note)}</span>
            </div>
            {a.label !== 'supported' && (
              <div style={{ fontSize: 11.5, marginTop: 3, color: blocked ? 'var(--green)' : guideOnly ? 'var(--amber)' : 'var(--red)' }}>
                {blocked
                  ? `🛡 ${t('legal.review.caught', { controls: hit.enforced.map((c) => t(`legal.control.${c}`)).join(', ') })}`
                  : guideOnly
                    ? `◐ ${t('legal.review.guideOnly', { controls: hit.guides.map((c) => t(`legal.control.${c}`)).join(', ') })}`
                    : `○ ${t('legal.review.uncaught')}`}
              </div>
            )}
          </div>
        )
      })}
      <div className="faint" style={{ marginTop: 8 }}>
        {flagged.length === 0
          ? t('legal.review.clean')
          : t('legal.review.flagged', { n: flagged.length, total: dossier.assertions.length })}
      </div>
      <div className="faint" style={{ marginTop: 4, color: residual > 0 ? 'var(--red)' : 'var(--green)' }}>
        {t('legal.review.residualLine', { flagged: flagged.length, caught, residual })}
      </div>
      <div className="faint" style={{ marginTop: 4 }}>
        {rules.length === 0 ? t('legal.review.aba.none') : t('legal.review.aba', { rules: rules.join(', ') })}
      </div>
    </div>
  )
}

/** F5-3 audit staircase: bare → soft (route) → hard, three curves. */
function Staircase({ bundle, dossierRefs, route }: { bundle: LegalBundle; dossierRefs: string[]; route: 'cn' | 'us' }) {
  const t = useT()
  const f = useFixture()
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
    <div className="panel" data-demo="stair">
      <h3>{t('legal.stair.title')} <span className="tag">{t('legal.stair.tag')}</span></h3>
      <div className="faint" style={{ marginBottom: 8 }}>{t('legal.stair.followRoute', { route: t(`legal.route.${route}`) })}</div>
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
      {st.references.map((r) => {
        // The curve-provenance line is global; other lines light up only for
        // dossiers that exemplify them (dossier.refs).
        const lit = r.id === STAIRCASE_GLOBAL_REF || dossierRefs.includes(r.id)
        return (
          <div key={r.id} style={{ fontSize: 12.5, color: 'var(--text-dim)', opacity: lit ? undefined : 0.45 }}>
            · {f(r.name)}: <b className="mono">{r.value}</b> <span className="faint">({r.citation})</span>
            {lit && r.id !== STAIRCASE_GLOBAL_REF && (
              <span className="src-badge src-live" style={{ marginLeft: 6 }}>{t('legal.stair.related')}</span>
            )}
          </div>
        )
      })}
      <div style={{ marginTop: 6 }}>{st.source.map((s, i) => <span key={i} style={{ marginRight: 6 }}><SourceBadge source={s as never} /></span>)}</div>
    </div>
  )
}

/** F5-4 compliance license card derived from enabled gates. */
function LicenseCard({ controls, route, residual, residualTypes, enforcedOn }: {
  controls: Record<LegalControl, boolean>
  route: 'cn' | 'us'
  residual: number
  residualTypes: LegalAssertion[]
  enforcedOn: number
}) {
  const t = useT()
  const { lang } = useI18n()
  const rows = ABA_DUTIES.map((d) => ({ ...d, covered: d.gates.every((g) => controls[g]) }))
  const covered = rows.filter((r) => r.covered).length
  return (
    <div className="panel" data-demo="license">
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
      <div className="faint" style={{ marginTop: 8 }}>{t('legal.route')}: {t(`legal.route.${route}`)} · {t('legal.license.enforcedCount', { count: enforcedOn })}</div>
      <div style={{ marginTop: 6, color: residual > 0 ? 'var(--red)' : 'var(--green)', fontSize: 12.5 }}>
        {t('legal.license.summary', { covered, total: rows.length, residual })}
      </div>
      <div className="faint" style={{ marginTop: 4 }}>
        {residual === 0
          ? t('legal.license.residualNone')
          : t('legal.license.residualItems', { types: residualTypes.map((r) => t(`legal.assert.${r}`)).join(', ') })}
      </div>
      <div className="faint" style={{ marginTop: 4 }}>{lang === 'zh' ? CN_FILING_NOTE.zh : CN_FILING_NOTE.en}</div>
    </div>
  )
}
