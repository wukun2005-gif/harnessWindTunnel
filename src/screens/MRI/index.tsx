import { useEffect, useMemo, useRef, useState } from 'react'
import { BASE_CONFIG, COMPONENT_META, CONFIG_FIELDS } from '../../../shared/config'
import { LAYER_LABEL, SHAPER_LABEL, type HarnessEvent, type SourceRef } from '../../../shared/events'
import { MAST_HINT, MAST_LABEL, type MastTag } from '../../../shared/mast'
import { useApp, useRun, useTunnel } from '../../stores'
import { api } from '../../api'
import { useT, useFixture } from '../../i18n'
import { fmtTokens } from '../../lib/derive'
import { ReadGuide } from '../../components/ReadGuide'

export function SourceBadge({ source }: { source: SourceRef }) {
  const t = useT()
  const f = useFixture()
  const cls = source.kind === 'paper-reproduction' ? 'src-paper' : source.kind === 'live' ? 'src-live' : source.kind === 'imported' ? 'src-imported' : 'src-fixture'
  // Runtime-composed nearest-neighbor label carries an interpolated field count.
  const approx = /^Approximate · nearest-neighbor branch \(differs by (\d+) fields\)$/.exec(source.label)
  const label = approx ? t('tunnel.readings.approximate', { distance: approx[1] }) : f(source.label)
  return <span className={`src-badge ${cls}`} title={source.citation ?? ''}>{label}</span>
}

export default function MRI() {
  const { scenarios, metas, current, select } = useApp()
  const meta = metas[current]
  const { run, meta: runMeta, load, loading } = useRun()
  const [branch, setBranch] = useState('')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const t = useT()

  // Failure-tag census for THIS run. The left panel used to list all five tags
  // in red regardless of what happened, so a clean run still looked broken.
  const mastHits = useMemo(() => {
    const m = new Map<MastTag, { count: number; step: number }>()
    run?.events.forEach((e) => {
      if (e.type !== 'failure.tag') return
      const prev = m.get(e.mast)
      if (prev) prev.count += 1
      else m.set(e.mast, { count: 1, step: e.step })
    })
    return m
  }, [run])

  useEffect(() => {
    if (!meta) return
    // Honor a run prepared elsewhere (another screen may carry scenario+branch):
    // adopt it instead of resetting to the first branch.
    if (runMeta && runMeta.scenarioId === current && meta.branches.some((b) => b.branchId === runMeta.branchId)) {
      setBranch(runMeta.branchId)
      return
    }
    if (!branch) {
      const b = meta.branches[0]?.branchId ?? ''
      setBranch(b)
      if (b) { void load(current, b) }
    }
  }, [meta]) // eslint-disable-line react-hooks/exhaustive-deps

  const f = useFixture()
  const T = useTunnel()
  const onBranch = (b: string) => { setBranch(b); void load(current, b); T.loadBranchConfig(current, b) }
  const onScenario = (id: string) => { select(id); setBranch(''); T.setScenario(id) }

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">{t('mri.eyebrow')}</span>
        <h1>{t('mri.title')}</h1>
        <span className="q">{t('mri.subtitle')}</span>
      </div>
      <ReadGuide keys={['guide.insight.1', 'guide.insight.2', 'guide.insight.3']} />
      <RunConclusion />
      <div className="mri-layout">
        {/* Left toggle button — always visible */}
        <button
          className={`mri-toggle mri-toggle-left ${leftOpen ? 'open' : ''}`}
          onClick={() => setLeftOpen(!leftOpen)}
          title={leftOpen ? t('mri.toggle.collapseLeft') : t('mri.toggle.expandLeft')}
        >{leftOpen ? '◀' : '▶'}</button>

        {/* Left panel */}
        <div className={`mri-left ${leftOpen ? '' : 'collapsed'}`}>
          <div className="panel">
            <h3>{t('mri.scenario.label')} <span className="tag">{t('mri.scenario.tag')}</span></h3>
            <select value={current} onChange={(e) => onScenario(e.target.value)} style={{ width: '100%' }}>
              {scenarios.map((s) => <option key={s.scenarioId} value={s.scenarioId}>{t(`scenario.${s.scenarioId}.family`) !== `scenario.${s.scenarioId}.family` ? t(`scenario.${s.scenarioId}.family`) : s.familyLabel} · {s.scenarioId}</option>)}
            </select>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(meta?.branches ?? []).filter((b) => b.file).map((b) => (
                <button key={b.branchId} data-demo-branch={b.branchId} className={branch === b.branchId ? 'active-btn' : ''} onClick={() => onBranch(b.branchId)}>
                  {t(`mri.branch.${b.branchId}`) !== `mri.branch.${b.branchId}` ? t(`mri.branch.${b.branchId}`) : b.branchId}
                </button>
              ))}
            </div>
          </div>
          <ImportPanel />
          {runMeta && (() => {
            const curBranch = meta?.branches.find((b) => b.branchId === (runMeta.branchId ?? branch)) ?? meta?.branches.find((b) => b.branchId === branch)
            const activeFields = curBranch ? CONFIG_FIELDS.filter((f) => curBranch.config[f] !== BASE_CONFIG[f]) : []
            return (
            <div className="panel">
              <h3>{t('mri.meta.title')}</h3>
              <dl className="kv">
                <dt>runId</dt><dd className="mono">{runMeta.runId}</dd>
                <dt>{t('mri.meta.model')}</dt><dd>{t('model.gpt-5.4-xhigh') !== 'model.gpt-5.4-xhigh' ? t('model.gpt-5.4-xhigh') : meta?.model}</dd>
                <dt>{t('mri.meta.scenario')}</dt><dd><SourceBadge source={runMeta.source} /></dd>
              </dl>
              {curBranch && (
                <>
                  <hr className="hr" />
                  <div className="faint">{t('mri.meta.active')} ({activeFields.length})</div>
                  {activeFields.length === 0
                    ? <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>—</div>
                    : activeFields.map((f) => (
                      <div key={f} style={{ fontSize: 12.5, color: 'var(--text-dim)' }} title={f}>
                        · {COMPONENT_META[f].label}: <span className="mono">{String(curBranch.config[f])}</span>
                      </div>
                    ))}
                </>
              )}
              <hr className="hr" />
              <div className="faint">{t('mri.traps')}</div>
              {(meta?.traps ?? []).map((trap) => <div key={trap} style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>· {f(trap)}</div>)}
            </div>
            )
          })()}
          <div className="panel">
            <h3>{t('mri.mast.tags')}</h3>
            {(Object.keys(MAST_LABEL) as MastTag[]).filter((k) => k !== 'other').map((k) => {
              const hit = mastHits.get(k)
              return (
                <div key={k} className={`mast-tag ${hit ? 'hit' : 'idle'}`} title={f(MAST_HINT[k])}>
                  <span className="mono">{f(MAST_LABEL[k])}</span>
                  <span className="mast-tag-state">
                    {hit ? t('mri.mast.hits', { count: hit.count, step: hit.step }) : t('mri.mast.clean')}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        {/* Middle column */}
        <div className="mri-mid">
          <TimelinePlayer />
        </div>

        {/* Right panel */}
        <div className={`mri-right ${rightOpen ? '' : 'collapsed'}`}>
          <ContextInspector />
        </div>

        {/* Right toggle button — always visible */}
        <button
          className={`mri-toggle mri-toggle-right ${rightOpen ? 'open' : ''}`}
          onClick={() => setRightOpen(!rightOpen)}
          title={rightOpen ? t('mri.toggle.collapseRight') : t('mri.toggle.expandRight')}
        >{rightOpen ? '▶' : '◀'}</button>
      </div>
    </div>
  )
}

/** One-line verdict for the replayed run, above the fold. */
function RunConclusion() {
  const { run, setPlayhead, setPlaying } = useRun()
  const t = useT()
  const f = useFixture()
  if (!run || run.steps.length === 0) {
    return (
      <div className="panel conclusion-card">
        <h3>{t('mri.conclusion.title')}</h3>
        <div className="faint">{t('mri.conclusion.empty')}</div>
      </div>
    )
  }
  const finish = run.finish
  const steps = run.steps
  const totalTokens = finish?.tokens ?? steps.reduce((n, s) => n + s.estTokens, 0)
  const peak = steps.reduce((a, b) => (b.estTokens > a.estTokens ? b : a), steps[0])
  const fires = run.events.filter((e): e is Extract<HarnessEvent, { type: 'shaper.fire' }> => e.type === 'shaper.fire')
  const freed = fires.reduce((n, e) => n + e.freedTokens, 0)
  const failureEntries = Object.entries(finish?.failureModes ?? {}) as [MastTag, number][]
  const top = [...failureEntries].sort((a, b) => b[1] - a[1])[0]
  const crit = run.criticalStep != null ? steps.find((s) => s.step === run.criticalStep) : undefined
  const success = finish?.success ?? (crit === undefined && failureEntries.length === 0)
  const jump = () => {
    if (!crit) return
    setPlaying(false)
    setPlayhead(crit.reqIdx + 1)
  }

  return (
    <div className={`panel conclusion-card ${success ? 'ok' : 'fail'}`}>
      <h3>{t('mri.conclusion.title')}</h3>
      <div className="conclusion-grid">
        <div className="conclusion-verdict">
          <span className={`verdict-pill ${success ? 'ok' : 'fail'}`}>{success ? t('mri.conclusion.ok') : t('mri.conclusion.fail')}</span>
          <p>
            {success
              ? t('mri.conclusion.okLine')
              : crit
                ? t('mri.conclusion.failLine', { step: crit.step, mode: top ? f(MAST_LABEL[top[0]]) : '—' })
                : t('mri.conclusion.failNoStep')}
          </p>
          {crit && (
            <button className="chip" onClick={jump}>◆ {t('mri.conclusion.jump', { step: crit.step })}</button>
          )}
        </div>
        <div className="conclusion-facts">
          <div><span>{t('mri.conclusion.steps')}</span><b>{steps.length}</b></div>
          <div><span>{t('mri.conclusion.tokens')}</span><b>{fmtTokens(totalTokens)}</b></div>
          <div><span>{t('mri.conclusion.latency')}</span><b>{finish ? `${(finish.latencyP50 / 1000).toFixed(1)}s` : '—'}</b></div>
          <div className="wide">{t('mri.conclusion.pressure', { tokens: fmtTokens(peak.estTokens), step: peak.step })}</div>
          <div className="wide">{fires.length ? t('mri.conclusion.shaper', { count: fires.length, tokens: fmtTokens(freed) }) : t('mri.conclusion.noShaper')}</div>
          <div className="wide">{top ? t('mri.conclusion.dominant', { mode: f(MAST_LABEL[top[0]]), count: top[1] }) : t('mri.conclusion.noFailure')}</div>
        </div>
      </div>
      <div className="faint" style={{ marginTop: 6 }}>{t('mri.conclusion.measured')}</div>
    </div>
  )
}

/** F4-5 transcript import: file or built-in sample → normalized events → MRI replay. */
function ImportPanel() {
  const t = useT()
  const { loadImported } = useRun()
  const [open, setOpen] = useState(false)
  const [format, setFormat] = useState<'claude' | 'dsh' | 'hwt'>('claude')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const send = async (fmt: 'claude' | 'dsh' | 'hwt', text: string, label: string) => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const r = await api.importEvents(fmt, text)
      loadImported(r.events as HarnessEvent[], label)
      setInfo(t('mri.import.ok', { events: r.events.length, skipped: r.skipped }))
    } catch (e) {
      setError(t('mri.import.error', { error: e instanceof Error ? e.message : String(e) }))
    } finally {
      setBusy(false)
    }
  }
  const onFile = async (file: File) => {
    try {
      await send(format, await file.text(), file.name)
    } catch (e) {
      setError(t('mri.import.error', { error: e instanceof Error ? e.message : String(e) }))
    }
  }
  const onSample = async (name: 'claude' | 'dsh') => {
    setBusy(true)
    setError(null)
    setInfo(null)
    try {
      const s = await api.importSample(name)
      await send(name, s.text, `sample:${name}`)
    } catch (e) {
      setError(t('mri.import.error', { error: e instanceof Error ? e.message : String(e) }))
      setBusy(false)
    }
  }

  return (
    <div className="panel" data-demo="import">
      <h3
        style={{ cursor: 'pointer', marginBottom: open ? undefined : 0 }}
        onClick={() => setOpen(!open)}
      >
        {t('mri.import.title')} <span className="tag">{t('mri.import.tag')}</span>
        <button
          className="chip"
          style={{ float: 'right' }}
          onClick={(e) => { e.stopPropagation(); setOpen(!open) }}
        >{open ? '−' : t('mri.import.expand')}</button>
      </h3>
      {!open ? (
        <div className="faint" style={{ marginTop: 4 }}>{t('mri.import.collapseHint')}</div>
      ) : (
      <>
      <div className="faint" style={{ marginBottom: 8 }}>{t('mri.import.desc')}</div>
      <label className="faint" style={{ display: 'grid', gap: 4, fontSize: 12, marginBottom: 8 }}>
        <select value={format} onChange={(e) => setFormat(e.target.value as 'claude' | 'dsh' | 'hwt')} style={{ width: '100%' }}>
          <option value="claude">{t('mri.import.claude')}</option>
          <option value="dsh">{t('mri.import.dsh')}</option>
          <option value="hwt">{t('mri.import.hwt')}</option>
        </select>
      </label>
      <button className="primary" disabled={busy} style={{ width: '100%', marginBottom: 10 }} onClick={() => fileRef.current?.click()}>{t('mri.import.file')}</button>
      <input ref={fileRef} type="file" accept=".jsonl,.json,.txt" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = '' }} />
      <div className="faint" style={{ textAlign: 'center', marginBottom: 6 }}>— {t('mri.import.orSample')} —</div>
      <div style={{ display: 'flex', gap: 6 }}>
        {(['claude', 'dsh'] as const).map((n) => (
          <button key={n} disabled={busy} style={{ flex: 1, padding: '4px 8px', fontSize: 12 }} onClick={() => void onSample(n)}>
            {t('mri.import.sample', { name: n === 'claude' ? 'Claude' : 'dsh' })}
          </button>
        ))}
      </div>
      {busy && <div className="faint" style={{ marginTop: 6 }}>{t('common.loading')}</div>}
      {info && <div style={{ color: 'var(--green)', fontSize: 12, marginTop: 6 }}>{info}</div>}
      {error && <div style={{ color: 'var(--red)', fontSize: 12, marginTop: 6 }}>{error}</div>}
      </>
      )}
    </div>
  )
}

function TimelinePlayer() {
  const { run, playhead, playing, speed, setPlayhead, setPlaying, setSpeed, tick } = useRun()
  const [selected, setSelected] = useState<number>(1)
  const t = useT()
  const f = useFixture()

  useEffect(() => {
    if (!playing) return
    const t = setInterval(tick, Math.max(16, 90 / speed))
    return () => clearInterval(t)
  }, [playing, speed, tick])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') { setPlaying(false); setPlayhead(playhead - 1) }
      if (e.key === 'ArrowRight') { setPlaying(false); setPlayhead(playhead + 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [playhead, setPlayhead, setPlaying])

  const visibleSteps = useMemo(
    () => (run ? run.steps.filter((s) => s.reqIdx < playhead || playhead === 0) : []),
    [run, playhead],
  )
  const cur = visibleSteps.find((s) => s.step === selected) ?? visibleSteps[visibleSteps.length - 1]
  useEffect(() => { if (cur) setSelected(cur.step) }, [cur?.step]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!run) return <div className="panel loading">{useRun.getState().loading ? t('mri.loading') : t('mri.select.branch')}</div>
  const total = run.events.length

  return (
    <div>
      <div className="panel">
        <h3>
          {t('mri.timeline.title')} <span className="tag">{t('mri.timeline.tag')}</span>
          <span style={{ float: 'right' }} className="faint mono">{playhead}/{total} {t('mri.events')}</span>
        </h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
          <button onClick={() => { setPlaying(false); setPlayhead(0) }}>⏮</button>
          <button onClick={() => setPlayhead(playhead - 1)}>◀</button>
          <button className={playing ? '' : 'primary'} onClick={() => setPlaying(!playing)}>{playing ? t('mri.pause') : t('mri.play')}</button>
          <button onClick={() => setPlayhead(playhead + 1)}>▶|</button>
          <span className="faint">{t('mri.speed')}</span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} style={{ width: 68, padding: '2px 4px' }}>
            {[0.5, 1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
          </select>
          <input
            type="range" min={0} max={total} value={playhead}
            onChange={(e) => { setPlaying(false); setPlayhead(Number(e.target.value)) }}
            style={{ flex: 1, accentColor: 'var(--accent)' }}
          />
          <span className="faint">{t('mri.step.hint')}</span>
        </div>
        <div className="tl-rail-head">
          <span>{t('mri.rail.title', { count: run.steps.length })}</span>
          <span className="faint">{t('mri.rail.hint')}</span>
        </div>
        <div className="tl-rail">
          {run.steps.map((s) => {
            const vis = s.reqIdx < playhead
            const critical = run.criticalStep === s.step
            const failed = s.tags.length > 0
            return (
              <button
                key={s.step}
                className={`tl-cell ${vis ? 'vis' : 'unseen'}${critical ? ' critical' : ''}${failed ? ' failed' : ''}${cur?.step === s.step ? ' cur' : ''}`}
                title={f(s.thought)}
                onClick={() => { setPlaying(false); setPlayhead(s.reqIdx + 1); setSelected(s.step) }}
              >
                <span className="n">{s.step}</span>
                <span className="tk">{fmtTokens(s.estTokens)}</span>
                {critical && <span className="dia">◆</span>}
                {failed && !critical && <span className="dia">●</span>}
              </button>
            )
          })}
        </div>
        <div className="tl-wrap">
          <div className="tl-track">
            {run.steps.map((s) => {
              const vis = s.reqIdx < playhead
              const critical = run.criticalStep === s.step
              const marks = [...s.markers, ...s.tags].filter((m) => m.idx < playhead).sort((a, b) => a.idx - b.idx)
              return (
                <div
                  key={s.step}
                  className={`tl-step ${vis ? (cur?.step === s.step ? 'cur' : 'past') : ''}${critical ? ' critical' : ''}`}
                  style={{ opacity: vis ? undefined : 0.3 }}
                  onClick={() => { setPlaying(false); setPlayhead(s.reqIdx + 1); setSelected(s.step) }}
                >
                  <div className="sn">{t('mri.step.line', { step: s.step, tokens: fmtTokens(s.estTokens) })}</div>
                  {critical && <div className="crit-diamond" title={t('mri.critical.banner')}>{t('mri.critical.badge')}</div>}
                  <div className="thought">{f(s.thought)}</div>
                  <div className="tools">{s.tools.map((t, i) => <span key={i}>{t.tool}</span>)}</div>
                  {marks.map((m, i) => (
                    <span
                      key={i} className={`tl-mark mk-${m.kind}`}
                      style={{ left: '50%', top: `${100 + i * 19}px` }}
                      title={f(m.detail)}
                    >{f(m.label)}</span>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="panel" data-demo="stepdetail">
        <h3>{t('mri.step.details')} {cur ? <span className="tag mono">{t('mri.step.tag', { step: cur.step })}</span> : null}</h3>
        {cur ? (
          <>
            {run.criticalStep === cur.step && <div className="crit-banner">{t('mri.critical.banner')}</div>}
            <div style={{ fontSize: 13.5, color: 'var(--text)' }}>{f(cur.thought)}</div>
            {cur.tools.map((tool, i) => (
              <div key={i} style={{ margin: '7px 0', fontSize: 12.5 }}>
                <span className="mono" style={{ color: 'var(--blue)' }}>{tool.tool}</span>
                <span className="faint">({f(tool.argsSummary)})</span>
                {tool.summary && <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>↳ {f(tool.summary)}{tool.tokens ? <span className="faint mono"> · {fmtTokens(tool.tokens)} tk</span> : null}</div>}
              </div>
            ))}
            {(cur.markers.length > 0 || cur.tags.length > 0) && <hr className="hr" />}
            {cur.markers.length > 0 && (
              <>
                <div className="faint" style={{ marginBottom: 4 }}>{t('mri.interventions')}</div>
                {cur.markers.map((m, i) => (
                  <div key={i} style={{ fontSize: 12.5, margin: '3px 0' }}>
                    <span className={`tl-mark mk-${m.kind}`} style={{ position: 'static', display: 'inline-block', transform: 'none' }}>{f(m.label)}</span>
                    <span className="muted"> {f(m.detail)}</span>
                  </div>
                ))}
              </>
            )}
            {cur.tags.length > 0 && (
              <>
                <div className="faint" style={{ marginBottom: 4, marginTop: cur.markers.length > 0 ? 8 : 0 }}>{t('mri.annotations')}</div>
                {cur.tags.map((m, i) => (
                  <div key={i} style={{ fontSize: 12.5, margin: '3px 0' }}>
                    <span className={`tl-mark mk-${m.kind}`} style={{ position: 'static', display: 'inline-block', transform: 'none' }}>{f(m.label)}</span>
                    <span className="muted"> {f(m.detail)}</span>
                    {m.author && m.author !== 'harness' && <span className="faint mono">{t('mri.author', { author: m.author })}</span>}
                  </div>
                ))}
              </>
            )}
          </>
        ) : <div className="faint">{t('mri.click.step')}</div>}
      </div>
    </div>
  )
}


function ContextInspector() {
  const { run, playhead } = useRun()
  const { scenarios, metas, current } = useApp()
  const meta = metas[current]
  const t = useT()
  const f = useFixture()

  const cur = useMemo(() => {
    if (!run) return null
    const vis = run.steps.filter((s) => s.reqIdx < playhead)
    // Before playback starts there is still a real stack to show: the one the
    // model saw on its first call. An empty right rail reads as "no data".
    return vis[vis.length - 1] ?? run.steps[0] ?? null
  }, [run, playhead])
  const initial = !!run && playhead === 0

  // 5-stage shaper cascade before current playhead
  const shapers = useMemo(() => {
    if (!run) return []
    const fires: HarnessEvent[] = []
    let lastCompactIdx = -1
    run.events.forEach((e, i) => {
      if (i >= playhead) return
      if (e.type === 'compact.boundary') { lastCompactIdx = i; fires.length = 0 }
      if (e.type === 'shaper.fire' && lastCompactIdx >= 0) fires.push(e)
    })
    return fires
  }, [run, playhead])

  if (!run || !cur) return <div className="panel"><h3>{t('mri.stack.title2')}</h3><div className="faint">{t('mri.awaiting')}</div></div>

  const n = cur.blocks.length
  const total = cur.estTokens
  const scenarioTraps = meta?.traps ?? []
  const shaperFreed = shapers.reduce((sum, e) => sum + (e.type === 'shaper.fire' ? e.freedTokens : 0), 0)
  const shaperFired = new Set(shapers.flatMap((e) => (e.type === 'shaper.fire' ? [e.shaper] : [])))

  return (
    <div className="panel scrollable">
      <div>
        <h3>
          {t('mri.stack.title2')} <span className="tag">{t('mri.step.what', { step: cur.step })}</span>
          <span style={{ float: 'right' }} className="mono" title={t('mri.stack.totalTokens')}>{fmtTokens(total)} tk</span>
        </h3>
        {initial && <div className="faint" style={{ marginBottom: 6 }}>{t('mri.stack.initial')}</div>}
        <div className="stack-bar">
          {cur.blocks.map((b, i) => (
            <div
              key={i} className={`stack-seg lyr-${b.layer}`}
              style={{ flex: Math.max(b.tokens / total, 0.012) }}
              title={`${f(LAYER_LABEL[b.layer])} · ${b.sourceComponent} · ${b.tokens} tk`}
            >
              {b.tokens / total > 0.1 && <span className="tk">{fmtTokens(b.tokens)}</span>}
            </div>
          ))}
        </div>
        <div className="stack-rows">
          {cur.blocks.map((b, i) => (
            <div key={i} className="stack-row">
              <span className={`sw lyr-${b.layer}`} />
              <span className="lyr">{f(LAYER_LABEL[b.layer])}</span>
              <span className="tk">{fmtTokens(b.tokens)} tk</span>
              {b.preview && <span className="faint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f(b.preview)}</span>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <h3>{t('mri.shaper.title')} <span className="tag">{t('mri.shaper.tag')}</span></h3>
        <div className="faint" style={{ marginBottom: 6 }}>{t('mri.shaper.cascade')}</div>
        <div className="shaper-stage">
          {(['budget', 'snip', 'microcompact', 'contextCollapse', 'autoCompact'] as const).map((name, i) => {
            const fire = shapers.find((f) => f.type === 'shaper.fire' && f.shaper === name)
            const lit = shaperFired.has(name)
            return (
              <div key={name} className={`shaper-row ${lit ? 'lit' : ''}`}>
                <span className="ord">{i + 1}</span>
                <span className="nm">{t(`mri.shaper.${name}`) !== `mri.shaper.${name}` ? t(`mri.shaper.${name}`) : SHAPER_LABEL[name]}</span>
                <span className={`st ${lit ? 'on' : 'off'}`}>{lit ? t('mri.shaper.fired') : t('mri.shaper.skipped')}</span>
                <span className="ds">{[t('mri.shaper.desc0'), t('mri.shaper.desc1'), t('mri.shaper.desc2'), t('mri.shaper.desc3'), t('mri.shaper.desc4')][i]}</span>
                <span className={`fr${lit && fire?.type === 'shaper.fire' ? '' : ' off'}`}>
                  {lit && fire?.type === 'shaper.fire' ? t('mri.shaper.freed', { tokens: fire.freedTokens }) : '—'}
                </span>
              </div>
            )
          })}
        </div>
        {shapers.length === 0
          ? <div className="faint" style={{ marginTop: 6 }}>{t('mri.shaper.empty')}</div>
          : <div className="faint" style={{ marginTop: 6 }}>{t('mri.shaper.freedTotal', { tokens: shaperFreed, count: shapers.length })}</div>}
      </div>
    </div>
  )
}
