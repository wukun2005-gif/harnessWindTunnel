import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useT, useFixture } from '../../i18n'
import { SourceBadge } from '../MRI'
import { downloadJson } from '../../lib/pack'
import { ReadGuide } from '../../components/ReadGuide'
import { paretoFrontier } from '../../../shared/reliability'
import {
  HONESTY_NOTE,
  KILL_CHAIN,
  SECURITY_CONTROLS,
  type AttackCase,
  type ControlPoint,
  type KillChainStage,
  type RedteamBundle,
  type SecurityControl,
} from '../../../shared/redteam'

const AXES = [(p: ControlPoint) => p.asr, (p: ControlPoint) => 100 - p.utility, (p: ControlPoint) => p.friction]

function matchCombo(points: ControlPoint[], sel: Record<SecurityControl, boolean>): { point: ControlPoint; exact: boolean } {
  const on = new Set(
    Object.entries(sel).filter(([, v]) => v).map(([k]) => k as SecurityControl),
  )
  let best = points[0]
  // Prefer the combo that contains every switch you turned on (fewest missing),
  // then the one carrying the fewest switches you did not ask for.
  let bestMissing = Infinity
  let bestExtra = Infinity
  let exact = false
  for (const p of points) {
    const set = new Set(p.controls)
    const inter = [...on].filter((c) => set.has(c)).length
    const missing = on.size - inter
    const extra = set.size - inter
    if (missing < bestMissing || (missing === bestMissing && extra < bestExtra)) {
      best = p
      bestMissing = missing
      bestExtra = extra
      exact = missing === 0 && extra === 0
    }
  }
  return { point: best, exact }
}

type StageWhy = 'blocked' | 'off' | 'bypassed' | 'noControl' | 'upstream'
type StageStatus = 'blocked' | 'breached' | 'not-reached'

interface DerivedStage {
  stage: KillChainStage
  status: StageStatus
  control?: SecurityControl
  why: StageWhy
  note: string
}

/**
 * Derive the chain from the switches, treating the attack as sequential: stages
 * run left to right, so the first blocked stage stops everything downstream.
 * Downstream stages are "not reached", never independently "breached".
 */
function deriveChain(attack: AttackCase, sel: Record<SecurityControl, boolean>): DerivedStage[] {
  const local: DerivedStage[] = KILL_CHAIN.map((stage) => {
    const s = attack.stages.find((x) => x.stage === stage)!
    const base = { stage, note: s.note }
    if (!s.blockedBy) return { ...base, status: 'breached', why: 'noControl' }
    if (!sel[s.blockedBy]) return { ...base, status: 'breached', control: s.blockedBy, why: 'off' }
    if (s.bypass) return { ...base, status: 'breached', control: s.blockedBy, why: 'bypassed' }
    return { ...base, status: 'blocked', control: s.blockedBy, why: 'blocked' }
  })
  const cut = local.findIndex((r) => r.status === 'blocked')
  if (cut < 0) return local
  return local.map((r, i) => (i <= cut ? r : { ...r, status: 'not-reached', why: 'upstream' }))
}

function chainStats(rows: DerivedStage[]): {
  cut: number | null
  cutStage?: KillChainStage
  deepest?: KillChainStage
} {
  const cut = rows.findIndex((r) => r.status === 'blocked')
  const deepest = cut < 0 ? rows[rows.length - 1]?.stage : rows[cut - 1]?.stage
  return { cut: cut >= 0 ? cut + 1 : null, cutStage: cut >= 0 ? rows[cut].stage : undefined, deepest }
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
        <div className="screen-head"><span className="no">{t('security.eyebrow')}</span><h1>{t('sec.title')}</h1></div>
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
        <span className="no">{t('security.eyebrow')}</span>
        <h1>{t('sec.title')}</h1>
        <span className="q">{t('sec.subtitle')}</span>
      </div>

      <ReadGuide keys={['guide.security.1', 'guide.security.2', 'guide.security.3']} />

      <ControlStrip sel={sel} setSel={setSel} matched={matched} exact={exact} setPolicyId={setPolicyId} />
      <KillChain attack={attack} attacks={bundle.attacks} select={setCaseId} sel={sel} />
      <Honesty />
      <div className="sec-main">
        <Ablation bundle={bundle} matched={matched} frontier={frontier} selectedId={policyId} setPolicyId={setPolicyId} />
        <Policy point={policyPoint} points={bundle.controls.points} setPolicyId={setPolicyId} approved={approved} setApproved={setApproved} />
      </div>
    </div>
  )
}

/** The cause: seven switches plus the combination they land on. */
function ControlStrip({ sel, setSel, matched, exact, setPolicyId }: {
  sel: Record<SecurityControl, boolean>
  setSel: (s: Record<SecurityControl, boolean>) => void
  matched: ControlPoint
  exact: boolean
  setPolicyId: (id: string) => void
}) {
  const t = useT()
  const f = useFixture()
  const onCount = SECURITY_CONTROLS.filter((c) => sel[c]).length
  const applyPreset = (list: readonly SecurityControl[]) =>
    setSel(
      Object.fromEntries(SECURITY_CONTROLS.map((c) => [c, list.includes(c)])) as Record<SecurityControl, boolean>,
    )
  return (
    <div className="panel sec-controls" data-demo="controls">
      <div className="sec-controls-head">
        <h3>{t('sec.controls.title')} <span className="tag">{t('sec.controls.tag')}</span></h3>
        <span className="faint">{t('sec.ablation.selected', { on: onCount, total: SECURITY_CONTROLS.length })}</span>
      </div>
      <div className="sec-presets">
        <button style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => applyPreset([])}>{t('sec.ablation.preset.bare')}</button>
        <button style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => applyPreset(['input-isolation', 'tool-boundary-gateway', 'least-privilege-creds', 'egress-dlp'])}>{t('sec.ablation.preset.recommended')}</button>
        <button style={{ padding: '2px 10px', fontSize: 12 }} onClick={() => applyPreset(SECURITY_CONTROLS)}>{t('sec.ablation.preset.all')}</button>
      </div>
      <div className="sec-switches">
        {SECURITY_CONTROLS.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={sel[c]}
            className={sel[c] ? 'active-btn' : ''}
            style={{ padding: '2px 10px', fontSize: 12 }}
            onClick={() => setSel({ ...sel, [c]: !sel[c] })}
          >{t(`security.control.${c}`)}</button>
        ))}
      </div>
      <div className="sec-hit">
        <b>{t('sec.ablation.matched', { label: f(matched.label) })}</b>
        <span className={`sec-hit-tag ${exact ? 'exact' : 'nearest'}`}>
          {exact ? t('sec.ablation.exact') : t('sec.ablation.nearest')}
        </span>
        <button className="sec-hit-use" onClick={() => setPolicyId(matched.id)}>{t('sec.controls.usePolicy')}</button>
        <span className="faint">{t('sec.controls.hint')}</span>
      </div>
    </div>
  )
}

/** F6-1 kill-chain flow with blast radius. */
function KillChain({ attack, attacks, select, sel }: {
  attack: AttackCase
  attacks: AttackCase[]
  select: (id: string) => void
  sel: Record<SecurityControl, boolean>
}) {
  const t = useT()
  const f = useFixture()
  const rows = deriveChain(attack, sel)
  const stats = chainStats(rows)
  const controlName = (c: SecurityControl) => t(`security.control.${c}`)
  const whyText = (row: DerivedStage): string => {
    switch (row.why) {
      case 'blocked':
        return t('sec.kill.derived.blocked', { control: controlName(row.control!) })
      case 'off':
        return t('sec.kill.derived.breached', { control: controlName(row.control!) })
      case 'bypassed':
        return t('sec.kill.derived.bypassed', { control: controlName(row.control!) })
      case 'upstream':
        return t('sec.kill.derived.upstream')
      default:
        return t('sec.kill.derived.noControl')
    }
  }
  const caseStats = new Map(attacks.map((c) => [c.id, chainStats(deriveChain(c, sel))]))
  const chipText = (st: ReturnType<typeof chainStats>) =>
    st.cut ? t('sec.kill.derived.chipCut', { n: st.cut }) : t('sec.kill.derived.chipAll')
  return (
    <div className="panel" data-demo="kill">
      <h3>{t('sec.kill.title')} <span className="tag">{t('sec.kill.tag')}</span></h3>
      <div className="kill-case-chips">
        {attacks.map((c) => {
          const st = caseStats.get(c.id)!
          return (
            <button
              key={c.id}
              className={c.id === attack.id ? 'active-btn' : ''}
              style={{ padding: '2px 10px', fontSize: 12 }}
              onClick={() => select(c.id)}
              title={chipText(st)}
            >
              {f(c.title)}
              <span className={`kill-chip-count ${st.cut ? 'stopped' : 'open'}`}>{chipText(st)}</span>
            </button>
          )
        })}
      </div>
      <div className="faint" style={{ marginBottom: 8 }}>{f(attack.tactic)}</div>
      <div className="faint" style={{ marginBottom: 6 }}>{t('sec.kill.chainHint')}</div>
      <div className="kill-derived">
        <span className="sec-derived-count">
          {stats.cut
            ? t('sec.kill.derived.summary', { n: stats.cut, stage: t(`security.stage.${stats.cutStage}`) })
            : t('sec.kill.derived.summaryNone')}
        </span>
        <span className="faint">{t('sec.kill.derived.caption')}</span>
        <span className="faint">
          {stats.cut === 1
            ? t('sec.kill.derived.reachedNone')
            : t('sec.kill.derived.reached', { stage: t(`security.stage.${stats.deepest}`) })}
        </span>
      </div>
      <div className="kill-track">
        {rows.map((row, i) => (
          <div key={row.stage} className={`kill-node ${row.status}`}>
            <span className="kill-step">{i + 1}</span>
            <span className="kill-name">{t(`security.stage.${row.stage}`)}</span>
            <span className="kill-badge">
              {row.status === 'blocked'
                ? t('sec.kill.blocked')
                : row.status === 'not-reached'
                  ? t('sec.kill.notReached')
                  : t('sec.kill.breached')}
            </span>
            <span className="kill-note">{whyText(row)}</span>
            <span className="kill-sample">{t('sec.kill.derived.sampleNote', { note: f(row.note) })}</span>
          </div>
        ))}
      </div>
      <div className="kill-blast">
        <b>{t('sec.kill.blastTitle')}</b>
        {attack.blastRadius.map((b) => (
          <span key={b} className="tl-mark mk-fail" style={{ position: 'static', display: 'inline-block', transform: 'none', marginRight: 4 }}>{b}</span>
        ))}
      </div>
      <div className="faint" style={{ marginTop: 6 }}>{f(attack.mapping)}</div>
    </div>
  )
}

/** F6-2 controls ablation with computed 3D Pareto. */
function Ablation({ bundle, matched, frontier, selectedId, setPolicyId }: {
  bundle: RedteamBundle
  matched: ControlPoint
  frontier: Set<string>
  selectedId: string
  setPolicyId: (id: string) => void
}) {
  const t = useT()
  const f = useFixture()
  const W = 560
  const H = 236
  const P = 40
  const px = (u: number) => P + ((u - 40) / 60) * (W - P - 16)
  const py = (a: number) => 16 + (a / 100) * (H - P - 20)
  const ranked = useMemo(
    () => [...bundle.controls.points].sort((a, b) => a.asr - b.asr || b.utility - a.utility),
    [bundle],
  )
  const rankOf = useMemo(() => new Map(ranked.map((p, i) => [p.id, i + 1])), [ranked])
  const radius = (p: ControlPoint) =>
    (p.id === matched.id ? 8 : 3.5 + (p.friction / 100) * 9) + (p.id === selectedId ? 2 : 0)
  // Draw the matched bubble last so it never hides behind another point.
  const drawOrder = [...bundle.controls.points].sort(
    (a, b) => (a.id === matched.id ? 1 : 0) - (b.id === matched.id ? 1 : 0),
  )
  return (
    <div className="panel" style={{ overflowX: 'auto' }} data-demo="pareto">
      <h3>{t('sec.ablation.title')} <span className="tag">{t('sec.ablation.tag')}</span></h3>
      <div className="faint sec-units">{t('sec.ablation.units')}</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }}>
        <line x1={P} y1={H - P} x2={W - 8} y2={H - P} stroke="var(--border-hi)" />
        <line x1={P} y1={16} x2={P} y2={H - P} stroke="var(--border-hi)" />
        <text x={W - 8} y={H - P + 14} textAnchor="end" fill="var(--text-faint)" fontSize="10">{t('sec.ablation.utility')}</text>
        <text x={P - 6} y={20} textAnchor="start" fill="var(--text-faint)" fontSize="10">ASR ↓</text>
        {drawOrder.map((p) => {
          const r = radius(p)
          return (
            <g key={p.id} onClick={() => setPolicyId(p.id)} style={{ cursor: 'pointer' }}>
              <title>{`${f(p.label)} · ASR ${p.asr.toFixed(1)}% · ${t('sec.ablation.utility')} ${p.utility.toFixed(1)}% · ${t('sec.ablation.friction')} ${p.friction.toFixed(0)}/100`}</title>
              <circle
                cx={px(p.utility)} cy={py(p.asr)} r={r}
                fill={p.id === matched.id ? 'var(--accent)' : 'var(--text-faint)'}
                opacity={p.id === matched.id || p.id === selectedId ? 0.9 : 0.5}
                stroke={p.id === selectedId ? 'var(--accent)' : frontier.has(p.id) ? 'var(--green)' : 'none'}
                strokeWidth={2}
              />
              <text
                x={px(p.utility)} y={py(p.asr) + r + 9} textAnchor="middle"
                className="sec-rank-label"
                fill={p.id === matched.id ? 'var(--accent)' : 'var(--text-faint)'}
                stroke="var(--bg-panel)" strokeWidth={3} paintOrder="stroke"
              >#{rankOf.get(p.id)}</text>
            </g>
          )
        })}
      </svg>
      <div className="faint" style={{ marginTop: 2 }}>{t('sec.ablation.legend')}</div>
      <div className="faint" style={{ marginTop: 10 }}>{t('sec.ablation.sideTitle', { n: ranked.length })}</div>
      <div className="sec-point-list">
        {ranked.map((p) => (
          <button
            key={p.id}
            className={[
              'sec-point',
              frontier.has(p.id) ? 'frontier' : '',
              p.id === matched.id ? 'matched' : '',
              p.id === selectedId ? 'selected' : '',
            ].join(' ')}
            onClick={() => setPolicyId(p.id)}
          >
            <span className="r">#{rankOf.get(p.id)}</span>
            <span className="lbl">
              {f(p.label)}
              {frontier.has(p.id) && <i>◆</i>}
              {p.id === matched.id && <em>{t('sec.ablation.matchedShort')}</em>}
            </span>
            <span className="m">{p.asr.toFixed(1)}%<small>ASR ↓</small></span>
            <span className="m">{p.utility.toFixed(1)}%<small>{t('sec.ablation.utility')}</small></span>
            <span className="m">{p.friction.toFixed(0)}<small>{t('sec.ablation.frictionUnit')}</small></span>
            <span className="use">{t('sec.policy.use')}</span>
          </button>
        ))}
      </div>
      <div className="faint" style={{ marginTop: 4 }}>{t('sec.ablation.sideHint')}</div>
      <div className="faint" style={{ marginTop: 10 }}>{t('sec.stories.title')}</div>
      {bundle.controls.stories.map((s) => (
        <div key={s.id} style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 2 }}>· {f(s.text)}</div>
      ))}
      <div className="faint" style={{ marginTop: 8 }}>{t('sec.refs.title')}</div>
      {bundle.controls.references.map((r) => (
        <div key={r.name} style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>· {f(r.name)}: <b className="mono">{r.value}</b> <span className="faint">({r.citation})</span></div>
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
    '# generated from Pareto point',
    'default allow = false', '',
    ...scopes.map((s) => `allow { input.scope == "${s}" }`),
    ...ask.map((a) => `ask { input.tool == "${a}" }`),
    ...refuse.map((r) => `deny { glob.match("${r}", input.destination) }`),
  ].join('\n')
  return {
    rego,
    claude: { allow: scopes, ask, deny: refuse },
    permissionRouter: [
      { tool: 'mail.send', route: gate ? 'ASK' : 'EXECUTE' },
      { tool: 'payout.*', route: dlp ? 'REFUSE' : gate ? 'ASK' : 'EXECUTE' },
      { tool: 'web.fetch', route: 'EXECUTE' },
      { tool: 'shell.exec', route: sandbox ? 'ASK' : 'REFUSE' },
    ],
    okta: { scopes, ttl: '15m' },
    wallet: { singleCap: 500, merchants: ['acme-corp'], overLimit: 'human-review' },
  }
}

/** Three enforcement layers; the five artifacts live inside them. */
const POLICY_GROUPS = [
  { id: 'engine', items: ['rego'] },
  { id: 'agent', items: ['claude', 'permissionRouter'] },
  { id: 'guard', items: ['okta', 'wallet'] },
] as const

/** F6-3 policy synthesis with per-item human approval before export. */
function Policy({ point, points, setPolicyId, approved, setApproved }: {
  point: ControlPoint
  points: ControlPoint[]
  setPolicyId: (id: string) => void
  approved: Record<string, boolean>
  setApproved: (a: Record<string, boolean>) => void
}) {
  const t = useT()
  const f = useFixture()
  const policy = useMemo(() => buildPolicy(point), [point])
  const items = Object.keys(policy)
  const [tab, setTab] = useState(items[0])
  const [copied, setCopied] = useState(false)
  const key = (item: string) => `${point.id}:${item}`
  const approvedCount = items.filter((item) => approved[key(item)]).length
  const allOk = approvedCount === items.length
  const active = items.includes(tab) ? tab : items[0]
  const text = typeof policy[active] === 'string'
    ? policy[active] as string
    : JSON.stringify(policy[active], null, 1)
  const copy = () => {
    if (!navigator.clipboard) return
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="panel" data-demo="policy">
      <h3>{t('sec.policy.title')} <span className="tag">{t('sec.policy.tag')}</span></h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="faint">{t('sec.policy.point')}</span>
        <select value={point.id} onChange={(e) => setPolicyId(e.target.value)}>
          {points.map((p) => <option key={p.id} value={p.id}>{f(p.label)}</option>)}
        </select>
      </div>
      <div className="faint" style={{ marginBottom: 6 }}>{t('sec.policy.tabHint')}</div>
      <div className="sec-tab-groups">
        {POLICY_GROUPS.map((group) => (
          <div className="sec-tab-group" key={group.id}>
            <span className="sec-tab-group-label">{t(`sec.policy.group.${group.id}`)}</span>
            <div className="sec-tab-group-items">
              {group.items.map((item) => (
                <button
                  key={item}
                  className={`sec-tab ${item === active ? 'on' : ''} ${approved[key(item)] ? 'done' : ''}`}
                  onClick={() => setTab(item)}
                >
                  <span className="artifact">{item}</span>
                  <span className="tick">{approved[key(item)] ? '✓' : ''}</span>
                  <span className="meta">{t(`sec.policy.meta.${item}`)}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="sec-tab-body">
        <div className="sec-tab-meta">
          <label className="sec-approve">
            <input
              type="checkbox"
              checked={!!approved[key(active)]}
              onChange={(e) => setApproved({ ...approved, [key(active)]: e.target.checked })}
            />
            {t('sec.policy.approveThis')}
          </label>
          <button className="sec-copy" onClick={copy}>{copied ? t('sec.policy.copied') : t('sec.policy.copy')}</button>
          <span className="faint">{t('sec.policy.approvedCount', { n: approvedCount, total: items.length })}</span>
        </div>
        <pre className="code-diff" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{text}</pre>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button
          className={allOk ? 'primary' : ''}
          disabled={!allOk}
          style={{ padding: '3px 14px', fontSize: 12 }}
          onClick={() => downloadJson(`policy-${point.id}.json`, { point: point.id, controls: point.controls, policy, approvedTabs: items, approvedBy: 'human', exportedAt: new Date().toISOString() })}
        >{t('sec.policy.export')}</button>
        {allOk && <span className="faint">{t('sec.policy.approvedCount', { n: approvedCount, total: items.length })}</span>}
      </div>
      {!allOk && <div className="faint" style={{ marginTop: 6 }}>{t('sec.policy.gate')}</div>}
    </div>
  )
}

/** F6-4 honesty boundary. */
function Honesty() {
  const t = useT()
  return (
    <div className="panel sec-honesty">
      <b>{t('sec.honesty.title')}</b>
      <span>{t('sec.honesty.note')}</span>
      <span className="faint">{t('sec.honesty.closed')}</span>
    </div>
  )
}
