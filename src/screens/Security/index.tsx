import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import { ScreenNav } from '../../components/ScreenNav'
import { SourceBadge } from '../MRI'
import { downloadJson } from '../../lib/pack'
import { paretoFrontier } from '../../../shared/reliability'
import {
  HONESTY_NOTE,
  KILL_CHAIN,
  KILL_CHAIN_LABEL,
  SECURITY_CONTROLS,
  SECURITY_CONTROL_LABEL,
  type AttackCase,
  type ControlPoint,
  type RedteamBundle,
  type SecurityControl,
} from '../../../shared/redteam'

const AXES = [(p: ControlPoint) => p.asr, (p: ControlPoint) => 100 - p.utility, (p: ControlPoint) => p.friction]

function matchCombo(points: ControlPoint[], sel: Record<SecurityControl, boolean>): { point: ControlPoint; exact: boolean } {
  const on = new Set(
    Object.entries(sel).filter(([, v]) => v).map(([k]) => k as SecurityControl),
  )
  let best = points[0]
  let bestScore = -Infinity
  let exact = false
  for (const p of points) {
    const set = new Set(p.controls)
    const inter = [...on].filter((c) => set.has(c)).length
    const score = inter * 2 - on.size - set.size
    if (score > bestScore) {
      bestScore = score
      best = p
      exact = on.size === set.size && inter === on.size
    }
  }
  return { point: best, exact }
}

export default function Security() {
  const t = useT()
  const [bundle, setBundle] = useState<RedteamBundle | null>(null)
  const [failed, setFailed] = useState(false)
  const [caseId, setCaseId] = useState('indirect-email')
  const [sel, setSel] = useState<Record<SecurityControl, boolean>>(() =>
    Object.fromEntries(
      SECURITY_CONTROLS.map((c) => [c, (['input-isolation', 'tool-boundary-gateway', 'least-privilege-creds', 'egress-dlp'] as SecurityControl[]).includes(c)]),
    ) as Record<SecurityControl, boolean>,
  )
  const [policyId, setPolicyId] = useState('leastpriv-dlp')
  const [approved, setApproved] = useState<Record<string, boolean>>({})

  useEffect(() => {
    let live = true
    api.redteam()
      .then((b) => { if (live) setBundle(b) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [])

  const frontier = useMemo(
    () => (bundle ? new Set(paretoFrontier(bundle.controls.points, AXES).map((p) => p.id)) : new Set<string>()),
    [bundle],
  )

  if (!bundle) {
    return (
      <div className="page">
        <div className="screen-head"><span className="no">SECURITY</span><h1>{t('sec.title')}</h1></div>
        <ScreenNav current="/security" />
        <div className="panel loading">{failed ? t('sec.error') : t('sec.loading')}</div>
      </div>
    )
  }

  const attack = bundle.attacks.find((c) => c.id === caseId) ?? bundle.attacks[0]
  const { point: matched, exact } = matchCombo(bundle.controls.points, sel)
  const policyPoint = bundle.controls.points.find((p) => p.id === policyId) ?? matched

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">SECURITY</span>
        <h1>{t('sec.title')}</h1>
        <span className="q">{t('sec.subtitle')}</span>
      </div>
      <ScreenNav current="/security" />

      <div className="grid-tunnel">
        <div>
          <KillChain attack={attack} attacks={bundle.attacks} select={setCaseId} />
          <Honesty />
        </div>
        <div>
          <Ablation bundle={bundle} sel={sel} setSel={setSel} matched={matched} exact={exact} frontier={frontier} setPolicyId={setPolicyId} />
          <Policy point={policyPoint} points={bundle.controls.points} setPolicyId={setPolicyId} approved={approved} setApproved={setApproved} />
        </div>
      </div>
    </div>
  )
}

/** F6-1 kill-chain flow with blast radius. */
function KillChain({ attack, attacks, select }: { attack: AttackCase; attacks: AttackCase[]; select: (id: string) => void }) {
  const t = useT()
  return (
    <div className="panel">
      <h3>{t('sec.kill.title')} <span className="tag">{t('sec.kill.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        {attacks.map((c) => (
          <button key={c.id} className={c.id === attack.id ? 'active-btn' : ''} style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => select(c.id)}>
            {c.title}
          </button>
        ))}
      </div>
      <div className="faint" style={{ marginBottom: 8 }}>{attack.tactic}</div>
      {KILL_CHAIN.map((stage) => {
        const s = attack.stages.find((x) => x.stage === stage)!
        const bad = s.status === 'breached'
        return (
          <div key={stage} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
            <span className="mono" style={{ width: 150, fontSize: 12 }}>{KILL_CHAIN_LABEL[stage]}</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: bad ? 'var(--red)' : 'var(--green)', width: 80 }}>
              {bad ? t('sec.kill.breached') : t('sec.kill.blocked')}
            </span>
            <span className="faint" style={{ flex: 1 }}>{s.note}</span>
          </div>
        )
      })}
      <div style={{ marginTop: 8, fontSize: 12 }}>
        <span className="faint">{t('sec.kill.blast')}: </span>
        {attack.blastRadius.map((b) => (
          <span key={b} className="tl-mark mk-fail" style={{ position: 'static', display: 'inline-block', transform: 'none', marginRight: 4 }}>{b}</span>
        ))}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>{attack.mapping}</div>
    </div>
  )
}

/** F6-2 controls ablation with computed 3D Pareto. */
function Ablation({ bundle, sel, setSel, matched, exact, frontier, setPolicyId }: {
  bundle: RedteamBundle
  sel: Record<SecurityControl, boolean>
  setSel: (s: Record<SecurityControl, boolean>) => void
  matched: ControlPoint
  exact: boolean
  frontier: Set<string>
  setPolicyId: (id: string) => void
}) {
  const t = useT()
  const W = 560
  const H = 200
  const P = 40
  const px = (u: number) => P + ((u - 40) / 60) * (W - P - 16)
  const py = (a: number) => 14 + (a / 100) * (H - P - 14)
  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <h3>{t('sec.ablation.title')} <span className="tag">{t('sec.ablation.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {SECURITY_CONTROLS.map((c) => (
          <button
            key={c}
            className={sel[c] ? 'active-btn' : ''}
            style={{ padding: '2px 10px', fontSize: 12 }}
            title={SECURITY_CONTROL_LABEL[c]}
            onClick={() => setSel({ ...sel, [c]: !sel[c] })}
          >{SECURITY_CONTROL_LABEL[c]}</button>
        ))}
      </div>
      <div className="faint" style={{ marginBottom: 6 }}>
        {t('sec.ablation.matched', { label: matched.label })}{' '}
        {!exact && <span style={{ color: 'var(--amber)' }}>{t('sec.ablation.nearest')}</span>}
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }}>
        <line x1={P} y1={H - P} x2={W - 8} y2={H - P} stroke="var(--border-hi)" />
        <line x1={P} y1={14} x2={P} y2={H - P} stroke="var(--border-hi)" />
        <text x={W - 8} y={H - P + 14} textAnchor="end" fill="var(--text-faint)" fontSize="10">{t('sec.ablation.utility')}</text>
        <text x={P - 6} y={18} textAnchor="start" fill="var(--text-faint)" fontSize="10">ASR ↓</text>
        {bundle.controls.points.map((p) => (
          <g key={p.id} onClick={() => setPolicyId(p.id)} style={{ cursor: 'pointer' }}>
            <circle
              cx={px(p.utility)} cy={py(p.asr)} r={p.id === matched.id ? 8 : 3 + (p.friction / 100) * 8}
              fill={p.id === matched.id ? 'var(--accent)' : 'var(--text-faint)'}
              opacity={p.id === matched.id ? 0.9 : 0.55}
              stroke={frontier.has(p.id) ? 'var(--green)' : 'none'}
              strokeWidth={2}
            />
            <text x={px(p.utility) + 10} y={py(p.asr) + 4} fill="var(--text-dim)" fontSize="11">{p.label}</text>
          </g>
        ))}
      </svg>
      <div className="faint" style={{ marginTop: 2 }}>{t('sec.ablation.legend')}</div>
      <table className="t" style={{ width: 'max-content', marginTop: 8 }}>
        <thead><tr><th>{t('sec.ablation.combo')}</th><th className="num">ASR ↓</th><th className="num">{t('sec.ablation.utility')}</th><th className="num">{t('sec.ablation.friction')}</th><th /></tr></thead>
        <tbody>
          {bundle.controls.points.map((p) => (
            <tr key={p.id} style={p.id === matched.id ? { background: 'rgba(34,211,238,.06)' } : undefined}>
              <td>
                {p.label}
                {frontier.has(p.id) && <span style={{ color: 'var(--green)', fontSize: 11 }}> ◆</span>}
              </td>
              <td className="num">{p.asr.toFixed(1)}%</td>
              <td className="num">{p.utility.toFixed(1)}%</td>
              <td className="num">{p.friction.toFixed(0)}</td>
              <td><button style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => setPolicyId(p.id)}>{t('sec.policy.use')}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="faint" style={{ marginTop: 10 }}>{t('sec.stories.title')}</div>
      {bundle.controls.stories.map((s) => (
        <div key={s.id} style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>· {s.text}</div>
      ))}
      <div className="faint" style={{ marginTop: 8 }}>{t('sec.refs.title')}</div>
      {bundle.controls.references.map((r) => (
        <div key={r.name} style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>· {r.name}: <b className="mono">{r.value}</b> <span className="faint">({r.citation})</span></div>
      ))}
      <div style={{ marginTop: 6 }}>{bundle.controls.source.map((s, i) => <span key={i} style={{ marginRight: 6 }}><SourceBadge source={s as never} /></span>)}</div>
    </div>
  )
}

function buildPolicy(p: ControlPoint): Record<string, unknown> {
  const leastPriv = p.controls.includes('least-privilege-creds')
  const gate = p.controls.includes('human-approval-gate')
  const dlp = p.controls.includes('egress-dlp')
  const sandbox = p.controls.includes('exec-sandbox')
  const scopes = leastPriv ? ['mail.read', 'crm.read'] : ['*']
  const ask = gate ? ['transfer.execute', 'payout.*'] : []
  const refuse = [...(dlp ? ['*.external', 'payout.unlisted'] : []), ...(sandbox ? [] : ['shell.exec'])]
  const rego = [
    'package agent.authz', '',
    '# generated from Pareto point (fixture demo)',
    'default allow = false', '',
    ...scopes.map((s) => `allow { input.scope == "${s}" }`),
    ...ask.map((a) => `ask { input.tool == "${a}" }`),
    ...refuse.map((r) => `deny { glob.match("${r}", input.destination) }`),
  ].join('\n')
  return {
    rego,
    claude: { allow: scopes, ask, deny: refuse },
    apass: [
      { tool: 'mail.send', route: gate ? 'ASK' : 'EXECUTE' },
      { tool: 'payout.*', route: dlp ? 'REFUSE' : gate ? 'ASK' : 'EXECUTE' },
      { tool: 'web.fetch', route: 'EXECUTE' },
      { tool: 'shell.exec', route: sandbox ? 'ASK' : 'REFUSE' },
    ],
    okta: { scopes, ttl: '15m' },
    wallet: { singleCap: 500, merchants: ['acme-corp'], overLimit: 'human-review' },
  }
}

/** F6-3 policy synthesis with per-item human approval before export. */
function Policy({ point, points, setPolicyId, approved, setApproved }: {
  point: ControlPoint
  points: ControlPoint[]
  setPolicyId: (id: string) => void
  approved: Record<string, boolean>
  setApproved: (a: Record<string, boolean>) => void
}) {
  const t = useT()
  const policy = useMemo(() => buildPolicy(point), [point])
  const items = Object.keys(policy)
  const key = (item: string) => `${point.id}:${item}`
  const allOk = items.every((item) => approved[key(item)])
  return (
    <div className="panel">
      <h3>{t('sec.policy.title')} <span className="tag">{t('sec.policy.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="faint">{t('sec.policy.point')}</span>
        <select value={point.id} onChange={(e) => setPolicyId(e.target.value)}>
          {points.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      {items.map((item) => (
        <div key={item} style={{ marginBottom: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
            <input type="checkbox" checked={!!approved[key(item)]} onChange={(e) => setApproved({ ...approved, [key(item)]: e.target.checked })} />
            <b className="mono">{item}</b>
          </label>
          <pre className="code-diff" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{JSON.stringify(policy[item], null, 1)}</pre>
        </div>
      ))}
      <button
        className={allOk ? 'primary' : ''}
        disabled={!allOk}
        style={{ padding: '3px 14px', fontSize: 12 }}
        onClick={() => downloadJson(`policy-${point.id}.json`, { point: point.id, controls: point.controls, policy, approvedBy: 'human', exportedAt: new Date().toISOString() })}
      >{t('sec.policy.export')}</button>
      {!allOk && <div className="faint" style={{ marginTop: 6 }}>{t('sec.policy.gate')}</div>}
    </div>
  )
}

/** F6-4 honesty boundary. */
function Honesty() {
  const t = useT()
  return (
    <div className="panel">
      <h3>{t('sec.honesty.title')}</h3>
      <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{t('sec.honesty.note')}</div>
      <div className="faint" style={{ marginTop: 6 }}>{t('sec.honesty.closed')}</div>
    </div>
  )
}
