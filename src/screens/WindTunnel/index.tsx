import { useEffect, useMemo, useRef, useState } from 'react'
import { BASE_CONFIG, COMPONENT_GROUPS, COMPONENT_META, CONFIG_FIELDS, fingerprint, type ConfigField } from '../../../shared/config'
import { hashSeed, isFragile, liftStats, pairedLifts } from '../../../shared/reliability'
import type { HarnessEvent, ScenarioMeta } from '../../../shared/events'
import { MAST_LABEL } from '../../../shared/mast'
import { PRESETS } from '../../../shared/presets'
import { api } from '../../api'
import { alignSteps, deriveRun, fmtMs, fmtTokens } from '../../lib/derive'
import { useApp, useTunnel, type VariantMetrics } from '../../stores'
import { useT, useFixture, useVariantLabel } from '../../i18n'
import { SourceBadge } from '../MRI'
import { ScreenNav } from '../../components/ScreenNav'

const dpp = (a: number, b: number) => {
  const d = a - b
  const s = `${d >= 0 ? '+' : ''}${d.toFixed(1)}pp`
  return <span className={d > 0.05 ? 'delta-pos' : d < -0.05 ? 'delta-neg' : 'delta-zero'}>{s}</span>
}

export default function WindTunnel() {
  const { scenarios, metas, current, select } = useApp()
  const T = useTunnel()
  const meta = metas[current]
  const t = useT()

  useEffect(() => { if (T.scenarioId !== current) T.setScenario(current) }, [current]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">SCREEN 02</span>
        <h1>{t('tunnel.title')}</h1>
        <span className="q">{t('tunnel.subtitle')}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="faint">{t('tunnel.scenario')}</span>
          <select value={current} onChange={(e) => select(e.target.value)}>
            {scenarios.map((s) => <option key={s.scenarioId} value={s.scenarioId}>{t(`scenario.${s.scenarioId}.family`) !== `scenario.${s.scenarioId}.family` ? t(`scenario.${s.scenarioId}.family`) : s.familyLabel}</option>)}
          </select>
        </div>
      </div>
      <ScreenNav current="/tunnel" />

      <div className="grid-tunnel">
        <div>
          <div className="panel">
            <h3>{t('tunnel.board.title')} <span className="tag">{t('tunnel.board.tag')}</span></h3>
            {COMPONENT_GROUPS.map((g) => (
              <div className="cgroup" key={g.group}>
                <div className="cgroup-title">{g.group}</div>
                {g.fields.map((f) => {
                  const m = COMPONENT_META[f]
                  const changed = T.config[f] !== BASE_CONFIG[f]
                  return (
                    <div className={`comp-row ${changed ? 'changed' : ''}`} key={f}>
                      <span className="dot" />
                      <span className="clabel" title={f}>{m.label}</span>
                      <select value={T.config[f]} onChange={(e) => T.setField(f as ConfigField, e.target.value)}>
                        {m.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                      {m.evidence && (
                        <div className="comp-ev">
                          <b>{m.label}</b><br />{m.evidence}
                          {m.enforced && <><br /><span style={{ color: 'var(--amber)' }}>{t('tunnel.board.enforced')}</span>{t('tunnel.board.soft')}</>}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button
                className="primary"
                style={{ flex: 1 }}
                onClick={() => T.addVariant(`${t('tunnel.variant')} ${T.variants.length + 1}`, { ...T.config })}
              >{t('tunnel.components.add')}</button>
              <button onClick={() => T.resetBoard()}>{t('tunnel.components.clear')}</button>
            </div>
            <div className="faint" style={{ marginTop: 6 }}>{t('tunnel.components.hint')}</div>
          </div>
        </div>

        <div>
          <RunMatrix meta={meta} />
          <TrajDiff meta={meta} />
        </div>
      </div>
    </div>
  )
}

function RunMatrix({ meta }: { meta?: ScenarioMeta }) {
  const label = useVariantLabel()
  const t = useT()
  const f = useFixture()
  const T = useTunnel()
  const { select } = useApp()
  const rows = T.variants.map((v) => ({ v, m: T.metrics[v.key] }))
  // F2-2 locked baseline (falls back to the first row when nothing is locked).
  const lockedKey = T.lockedKey ?? rows[0]?.v.key
  const base = rows.find((r) => r.v.key === lockedKey)?.m ?? rows.find((r) => r.m)?.m
  // A field identical across every row carries no comparative signal — dim it,
  // so the eye lands on what actually varies between variants.
  const consensus = new Set<ConfigField>()
  if (rows.length >= 2) {
    for (const k of CONFIG_FIELDS) {
      if (rows.every((r) => r.v.config[k] === rows[0].v.config[k])) consensus.add(k)
    }
  }
  const allModes = useMemo(() => {
    const s = new Set<string>()
    rows.forEach((r) => Object.keys(r.m?.failureModes ?? {}).forEach((k) => s.add(k)))
    return [...s]
  }, [rows])

  // Compute best/worst per column for conditional coloring
  const numericRows = rows.filter((r) => r.m)
  const best = {
    success: Math.max(...numericRows.map((r) => r.m!.successRate)),
    tokens: Math.min(...numericRows.map((r) => r.m!.tokens)),
    latency: Math.min(...numericRows.map((r) => r.m!.latencyP50)),
    failures: Math.min(...numericRows.map((r) => Object.values(r.m!.failureModes).reduce((a, b) => a + b, 0))),
  }
  const worst = {
    success: Math.min(...numericRows.map((r) => r.m!.successRate)),
    tokens: Math.max(...numericRows.map((r) => r.m!.tokens)),
    latency: Math.max(...numericRows.map((r) => r.m!.latencyP50)),
    failures: Math.max(...numericRows.map((r) => Object.values(r.m!.failureModes).reduce((a, b) => a + b, 0))),
  }
  const colorFor = (val: number, bestVal: number, worstVal: number, higherBetter: boolean) => {
    if (bestVal === worstVal) return undefined
    const isBest = higherBetter ? val >= bestVal : val <= bestVal
    const isWorst = higherBetter ? val <= worstVal : val >= worstVal
    return isBest ? 'var(--green)' : isWorst ? 'var(--red)' : undefined
  }

  return (
    <div className="panel" style={{ overflowX: 'auto' }}>
      <h3>{t('tunnel.readings.title')} <span className="tag">{t('tunnel.readings.tag')}</span>{T.fetching && <span className="faint">{t('tunnel.readings.fetching')}</span>}</h3>
      <div style={{ display: 'flex', gap: 8, margin: '6px 0 10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="faint">{t('tunnel.readings.quickload')}</span>
        {PRESETS.filter((p) => p.id === 'nlah-ablation' || p.id === 'harness-r1-regress').map((p) => (
          <button key={p.id} className="primary" style={{ padding: '2px 10px', fontSize: 12 }} title={p.tagline} onClick={() => { select(p.scenarioId); T.loadPresetVariants(p.scenarioId, p.variants) }}>▶ {p.title}</button>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="faint">{t('tunnel.readings.empty.hint')}</div>
      ) : (
      <>
      <table className="t" style={{ width: 'max-content' }}>
        <thead>
          <tr><th>{t('tunnel.readings.config')}</th><th>{t('tunnel.readings.diff') || 'Diff'}</th><th className="num">{t('tunnel.readings.success')}</th><th className="num">{t('tunnel.readings.delta')}</th><th className="num">{t('tunnel.readings.tokens')}</th><th className="num">{t('tunnel.readings.latency')}</th><th>{t('tunnel.readings.failures')}</th><th>{t('tunnel.readings.source')}</th><th /></tr>
        </thead>
        <tbody>
          {rows.map(({ v, m }) => {
            const fc = m ? Object.values(m.failureModes).reduce((a, b) => a + b, 0) : 0
            const changedFields = CONFIG_FIELDS.filter((k) => v.config[k] !== BASE_CONFIG[k])
            return (
            <tr key={v.key}>
              <td style={{ minWidth: 140 }}>
                <span style={{ color: v.color }}>■</span> {label(v.label)}
                {v.note && <div className="faint">{v.note}</div>}
                {!m?.exact && m && <div className="faint" style={{ color: 'var(--amber)' }}>{t('tunnel.readings.approximate', { distance: m.distance ?? '?' })}</div>}
              </td>
              <td style={{ fontSize: 11, color: 'var(--text-dim)', whiteSpace: 'normal', minWidth: 220 }}>
                {changedFields.length === 0 ? <span className="faint">—</span> : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {changedFields.map((k) => {
                      const cur = v.config[k]
                      const dimmed = consensus.has(k)
                      return <span key={k} style={{ whiteSpace: 'nowrap', opacity: dimmed ? 0.5 : 1 }} title={dimmed ? '与其他所有对照相同' : undefined}><span className="mono" style={{ color: dimmed ? 'var(--text-faint)' : 'var(--text)', fontWeight: dimmed ? undefined : 600 }} title={k}>{COMPONENT_META[k].label}</span> <span style={{ color: 'var(--red)', textDecoration: 'line-through' }}>{BASE_CONFIG[k]}</span> → <span style={{ color: 'var(--green)', fontWeight: dimmed ? undefined : 600 }}>{cur}</span></span>
                    })}
                  </div>
                )}
              </td>
              <td className="num" style={{ fontWeight: 600, color: m ? colorFor(m.successRate, best.success, worst.success, true) : undefined }}>{m ? `${m.successRate.toFixed(1)}%` : '…'}</td>
              <td className="num">{m && base ? dpp(m.successRate, base.successRate) : ''}</td>
              <td className="num" style={{ fontWeight: 600, color: m ? colorFor(m.tokens, best.tokens, worst.tokens, false) : undefined }}>{m ? fmtTokens(m.tokens) : ''}</td>
              <td className="num" style={{ fontWeight: 600, color: m ? colorFor(m.latencyP50, best.latency, worst.latency, false) : undefined }}>{m ? fmtMs(m.latencyP50) : ''}</td>
              <td style={{ fontWeight: 600, color: m ? colorFor(fc, best.failures, worst.failures, false) : undefined }}>
                {m && Object.entries(m.failureModes).map(([k, c]) => (
                  <span key={k} className="tl-mark mk-fail" style={{ position: 'static', display: 'inline-block', transform: 'none', marginRight: 4 }} title={f(MAST_LABEL[k as keyof typeof MAST_LABEL])}>{k}×{c}</span>
                ))}
              </td>
              <td>{m && <SourceBadge source={m.source as never} />}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                {v.key === lockedKey
                  ? <b style={{ color: 'var(--accent)', fontSize: 12 }} title={t('tunnel.baseline.locked')}>◉ {t('tunnel.baseline.locked')}</b>
                  : <button style={{ padding: '1px 8px', fontSize: 12 }} title={t('tunnel.baseline.lock')} onClick={() => T.lockBaseline(v.key)}>○</button>}{' '}
                <button className="danger" style={{ padding: '1px 8px', fontSize: 12 }} onClick={() => T.removeVariant(v.key)}>✕</button>
              </td>
            </tr>
            )
          })}
        </tbody>
      </table>

      {rows.length >= 2 && allModes.length > 0 && (
        <>
          <div className="faint" style={{ margin: '12px 0 6px' }}>{t('tunnel.matrix.title')}</div>
          <table className="t" style={{ width: 'max-content' }}>
            <thead><tr><th>{t('tunnel.matrix.mode')}</th>{rows.map(({ v }) => <th key={v.key} className="num">{label(v.label)}</th>)}</tr></thead>
            <tbody>
              {allModes.map((k) => (
                <tr key={k}>
                  <td><span className="mono" style={{ color: 'var(--red)' }}>{f(MAST_LABEL[k as keyof typeof MAST_LABEL])}</span></td>
                  {rows.map(({ v, m }) => {
                    const c = m?.failureModes[k] ?? 0
                    return <td key={v.key} className="num" style={{ background: c ? `rgba(248,113,113,${0.06 + 0.13 * c})` : undefined }}>{c || '·'}</td>
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {rows.length >= 1 && <LowerTail scenarioId={T.scenarioId} />}

      {rows.length >= 2 && (
        <>
          <div className="faint" style={{ margin: '12px 0 6px' }}>{t('tunnel.pareto.title')}</div>
          <Pareto rows={rows} />
        </>
      )}
      {meta && <div className="faint" style={{ marginTop: 8 }}>{t('tunnel.meta.task', { task: meta.task, model: meta.model })}</div>}
      </>)}
    </div>
  )
}

/** F2-6 reliability lower-tail: per-run lifts vs the locked baseline. */
function LowerTail({ scenarioId }: { scenarioId: string }) {
  const label = useVariantLabel()
  const t = useT()
  const T = useTunnel()
  const rows = T.variants.map((v) => ({ v, m: T.metrics[v.key] }))
  const lockedKey = T.lockedKey ?? rows[0]?.v.key
  const locked = rows.find((r) => r.v.key === lockedKey)?.m

  if (rows.length === 0 || !locked?.runs) {
    return rows.length === 0 ? null : <div className="faint" style={{ margin: '12px 0 6px' }}>{t('tunnel.lowertail.noruns')}</div>
  }
  const pp = (v: number) => {
    const s = `${v >= 0 ? '+' : ''}${v.toFixed(1)}pp`
    return <span className={v > 0.05 ? 'delta-pos' : v < -0.05 ? 'delta-neg' : 'delta-zero'}>{s}</span>
  }
  return (
    <>
      <div className="faint" style={{ margin: '12px 0 6px' }}>{t('tunnel.lowertail.title')} <span className="tag">{t('tunnel.lowertail.tag')}</span></div>
      <table className="t" style={{ width: 'max-content' }}>
        <thead><tr><th>{t('tunnel.readings.config')}</th><th className="num">MeanLift</th><th className="num">WorstLift</th><th className="num">RR₀</th><th className="num">RelLift₉₅</th><th>{t('tunnel.lowertail.verdict')}</th></tr></thead>
        <tbody>
          {rows.map(({ v, m }) => {
            if (v.key === lockedKey) {
              return (
                <tr key={v.key}>
                  <td><span style={{ color: v.color }}>■</span> {label(v.label)}</td>
                  <td className="num" colSpan={4} style={{ color: 'var(--text-faint)' }}>—</td>
                  <td><b style={{ color: 'var(--accent)', fontSize: 12 }}>◉ {t('tunnel.baseline.locked')}</b></td>
                </tr>
              )
            }
            const candRuns = m?.runs
            const baseRuns = locked.runs
            const stats = candRuns && baseRuns
              ? liftStats(pairedLifts(candRuns, baseRuns), hashSeed(`${scenarioId}:${fingerprint(v.config)}`))
              : null
            if (!stats) {
              return (
                <tr key={v.key}>
                  <td><span style={{ color: v.color }}>■</span> {label(v.label)}</td>
                  <td className="num" colSpan={4} style={{ color: 'var(--text-faint)' }}>…</td>
                  <td className="faint">{t('tunnel.lowertail.noruns')}</td>
                </tr>
              )
            }
            const fragile = isFragile(stats)
            return (
              <tr key={v.key}>
                <td><span style={{ color: v.color }}>■</span> {label(v.label)}</td>
                <td className="num">{pp(stats.meanLift)}</td>
                <td className="num">{pp(stats.worstLift)}</td>
                <td className="num">{(stats.rr0 * 100).toFixed(0)}%</td>
                <td className="num">{pp(stats.relLift95)}</td>
                <td>{fragile
                  ? <span style={{ color: 'var(--red)', fontSize: 12 }}>⚠ {t('tunnel.lowertail.fragile')}</span>
                  : <span style={{ color: 'var(--green)', fontSize: 12 }}>✓ {t('tunnel.lowertail.solid')}</span>}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

function Pareto({ rows }: { rows: { v: { key: string; label: string; color: string }; m?: VariantMetrics }[] }) {
  const label = useVariantLabel()
  const t = useT()
  const pts = rows.filter((r) => r.m)
  if (pts.length < 2) return null
  const W = 560, H = 170, P = 36
  const xs = pts.map((p) => p.m!.tokens)
  const ys = pts.map((p) => p.m!.successRate)
  const xMin = Math.min(...xs) * 0.92, xMax = Math.max(...xs) * 1.05
  const yMin = Math.min(...ys) - 4, yMax = Math.max(...ys) + 4
  const px = (x: number) => P + ((x - xMin) / (xMax - xMin)) * (W - P - 14)
  const py = (y: number) => H - P - ((y - yMin) / (yMax - yMin)) * (H - P - 14)
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }}>
      <line x1={P} y1={H - P} x2={W - 8} y2={H - P} stroke="var(--border-hi)" />
      <line x1={P} y1={12} x2={P} y2={H - P} stroke="var(--border-hi)" />
      <text x={W - 8} y={H - P + 14} textAnchor="end" fill="var(--text-faint)" fontSize="10">tokens →</text>
      <text x={P - 6} y={16} textAnchor="start" fill="var(--text-faint)" fontSize="10">{t('tunnel.chart.successRate')}</text>
      {pts.map(({ v, m }) => (
        <g key={v.key}>
          <circle cx={px(m!.tokens)} cy={py(m!.successRate)} r={6} fill={v.color} />
          <text x={px(m!.tokens) + 9} y={py(m!.successRate) + 4} fill="var(--text-dim)" fontSize="11">{label(v.label)} · {m!.successRate.toFixed(1)}%</text>
        </g>
      ))}
    </svg>
  )
}

function TrajDiff({ meta }: { meta?: ScenarioMeta }) {
  const t = useT()
  const [pair, setPair] = useState<[string, string] | null>(null)
  const [data, setData] = useState<{ a: ReturnType<typeof deriveRun>; b: ReturnType<typeof deriveRun> } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => { setPair(null); setData(null) }, [meta?.scenarioId])

  // Generate all valid pairs from branches with files
  const branches = (meta?.branches ?? []).filter((b) => b.file)
  const allPairs: [string, string][] = []
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      allPairs.push([branches[i].branchId, branches[j].branchId])
    }
  }
  const [left, setLeft] = useState<string>('')
  const [right, setRight] = useState<string>('')
  // Initialize selectors: prefer the scenario's declared first diff pair,
  // so branch display order never silently changes the default comparison.
  useEffect(() => {
    if (allPairs.length > 0 && !left && !right) {
      const declared = meta?.diffPairs?.[0]
      const ok = declared && branches.some((b) => b.branchId === declared[0]) && branches.some((b) => b.branchId === declared[1]) && declared[0] !== declared[1]
      if (ok) { setLeft(declared[0]); setRight(declared[1]) }
      else { setLeft(allPairs[0][0]); setRight(allPairs[0][1]) }
    }
  }, [allPairs])
  // Auto-load the default pair so arrivals from the Demo tour land on a
  // visible diff instead of an empty panel waiting on Compare.
  const loadedFor = useRef<string | null>(null)
  useEffect(() => {
    if (!meta || data || loading) return
    if (loadedFor.current === meta.scenarioId) return
    if (left && right && left !== right) {
      loadedFor.current = meta.scenarioId
      void load([left, right])
    }
  }, [meta, left, right, data, loading]) // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (p: [string, string]) => {
    if (!meta) return
    setPair(p); setLoading(true)
    const [ra, rb] = await Promise.all([
      api.replayBranch(meta.scenarioId, p[0]),
      api.replayBranch(meta.scenarioId, p[1]),
    ])
    setData({ a: deriveRun(ra.events as HarnessEvent[]), b: deriveRun(rb.events as HarnessEvent[]) })
    setLoading(false)
  }

  const loadSelected = () => { if (left && right && left !== right) load([left, right]) }

  const rows = data ? alignSteps(data.a.steps, data.b.steps) : []
  const firstDiverge = rows.findIndex((r) => !r.same)

  return (
    <div className="panel">
      <h3>{t('tunnel.diff.panel.title')} <span className="tag">{t('tunnel.diff.panel.tag')}</span></h3>
      {branches.length < 2 && <div className="faint">{t('tunnel.diff.empty')}</div>}
      {branches.length >= 2 && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10, alignItems: 'center' }}>
            <select value={left} onChange={(e) => setLeft(e.target.value)}>
              {branches.map((b) => <option key={b.branchId} value={b.branchId}>{b.branchId}</option>)}
            </select>
            <span className="faint">vs</span>
            <select value={right} onChange={(e) => setRight(e.target.value)}>
              {branches.map((b) => <option key={b.branchId} value={b.branchId}>{b.branchId}</option>)}
            </select>
            <button className="primary" style={{ padding: '3px 12px', fontSize: 12 }} onClick={loadSelected} disabled={left === right}>{t('tunnel.diff.compare') || 'Compare'}</button>
          </div>
        </>
      )}
      {loading && <div className="faint">{t('tunnel.diff.loading')}</div>}
      {data && pair && (
        <div className="diff-cols">
          {[{ d: data.a, id: pair[0] }, { d: data.b, id: pair[1] }].map(({ d, id }, side) => (
            <div className="diff-col" key={side}>
              <header>
                <b>{id}</b>
                <span className={`src-badge ${d.finish?.success ? 'src-live' : 'src-fixture'}`} style={{ borderColor: d.finish?.success ? 'rgba(52,211,153,.4)' : 'rgba(248,113,113,.4)', color: d.finish?.success ? 'var(--green)' : 'var(--red)' }}>
                  {d.finish?.success ? t('tunnel.diff.success') : t('tunnel.diff.failure')}
                </span>
              </header>
              <div className="diff-body">
                {rows.map((r) => {
                  const s = side === 0 ? r.a : r.b
                  return (
                    <div key={r.n} className={`diff-steprow ${r.same ? 'same' : 'diverge'}`}>
                      <span className="n">{r.n}</span>
                      <span className="tt">
                        {s ? <>{s.thought}<div className="faint">{s.tools.map((t) => t.tool).join(' · ')}</div></> : <i className="faint">{t('tunnel.diff.noStep')}</i>}
                        {s && (s.markers.length > 0 || s.tags.length > 0) && (
                          <div style={{ marginTop: 2 }}>
                            {[...s.markers, ...s.tags].sort((a, b) => a.idx - b.idx).map((m, i) => <span key={i} className={`tl-mark mk-${m.kind}`} style={{ position: 'static', display: 'inline-block', transform: 'none', marginRight: 4 }}>{m.label}</span>)}
                          </div>
                        )}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      {data && firstDiverge >= 0 && (
        <div className="faint" style={{ marginTop: 8 }}>{t('tunnel.diff.firstDiverge', { step: firstDiverge + 1 })}</div>
      )}
    </div>
  )
}
