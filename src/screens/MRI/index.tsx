import { useEffect, useMemo, useState } from 'react'
import { BASE_CONFIG, COMPONENT_META, CONFIG_FIELDS } from '../../../shared/config'
import { LAYER_LABEL, SHAPER_LABEL, type HarnessEvent, type SourceRef } from '../../../shared/events'
import { MAST_HINT, MAST_LABEL, type MastTag } from '../../../shared/mast'
import { useApp, useRun, useTunnel } from '../../stores'
import { useT, useFixture } from '../../i18n'
import { fmtTokens } from '../../lib/derive'
import { ScreenNav } from '../../components/ScreenNav'

export function SourceBadge({ source }: { source: SourceRef }) {
  const cls = source.kind === 'paper-reproduction' ? 'src-paper' : source.kind === 'live' ? 'src-live' : 'src-fixture'
  return <span className={`src-badge ${cls}`} title={source.citation ?? ''}>{source.label}</span>
}

export default function MRI() {
  const { scenarios, metas, current, select } = useApp()
  const meta = metas[current]
  const { run, meta: runMeta, load, loading } = useRun()
  const [branch, setBranch] = useState('')
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const t = useT()

  useEffect(() => {
    if (!meta) return
    // Honor a run prepared elsewhere (Demo handoff carries scenario+branch):
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
        <span className="no">SCREEN 01</span>
        <h1>{t('mri.title')}</h1>
        <span className="q">{t('mri.subtitle')}</span>
      </div>
      <ScreenNav current="/insight" />
      <div className="mri-layout">
        {/* Left toggle button — always visible */}
        <button
          className={`mri-toggle mri-toggle-left ${leftOpen ? 'open' : ''}`}
          onClick={() => setLeftOpen(!leftOpen)}
          title={leftOpen ? 'Collapse left panel' : 'Expand left panel'}
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
                <button key={b.branchId} className={branch === b.branchId ? 'active-btn' : ''} onClick={() => onBranch(b.branchId)}>
                  {t(`mri.branch.${b.branchId}`) !== `mri.branch.${b.branchId}` ? t(`mri.branch.${b.branchId}`) : b.branchId}
                </button>
              ))}
            </div>
          </div>
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
                {curBranch && <><dt>{t('mri.meta.config')}</dt><dd className="mono">{curBranch.fingerprint}</dd></>}
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
            {(Object.keys(MAST_LABEL) as MastTag[]).filter((k) => k !== 'other').map((k) => (
              <div key={k} style={{ fontSize: 12, marginBottom: 3 }} title={f(MAST_HINT[k])}>
                <span className="mono" style={{ color: 'var(--red)' }}>{f(MAST_LABEL[k])}</span>
              </div>
            ))}
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
          title={rightOpen ? 'Collapse right panel' : 'Expand right panel'}
        >{rightOpen ? '▶' : '◀'}</button>
      </div>
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
          {[1, 2, 4].map((s) => (
            <button key={s} className={speed === s ? 'active-btn' : ''} onClick={() => setSpeed(s)}>{s}×</button>
          ))}
          <input
            type="range" min={0} max={total} value={playhead}
            onChange={(e) => { setPlaying(false); setPlayhead(Number(e.target.value)) }}
            style={{ flex: 1, accentColor: 'var(--accent)' }}
          />
          <span className="faint">{t('mri.step.hint')}</span>
        </div>
        <div className="tl-wrap">
          <div className="tl-track">
            {run.steps.map((s) => {
              const vis = s.reqIdx < playhead
              const marks = [...s.markers, ...s.tags].filter((m) => m.idx < playhead).sort((a, b) => a.idx - b.idx)
              return (
                <div
                  key={s.step}
                  className={`tl-step ${vis ? (cur?.step === s.step ? 'cur' : 'past') : ''}`}
                  style={{ opacity: vis ? undefined : 0.3 }}
                  onClick={() => { setPlaying(false); setPlayhead(s.reqIdx + 1); setSelected(s.step) }}
                >
                  <div className="sn">STEP {s.step} · {fmtTokens(s.estTokens)} tk</div>
                  <div className="thought">{f(s.thought)}</div>
                  <div className="tools">{s.tools.map((t, i) => <span key={i}>{t.tool}</span>)}</div>
                  {marks.map((m, i) => (
                    <span
                      key={i} className={`tl-mark mk-${m.kind}`}
                      style={{ left: '50%', top: `${100 + i * 19}px` }}
                      title={m.detail}
                    >{f(m.label)}</span>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>{t('mri.step.details')} {cur ? <span className="tag mono">STEP {cur.step}</span> : null}</h3>
        {cur ? (
          <>
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
                    <span className="muted"> {m.detail}</span>
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
                    <span className="muted"> {m.detail}</span>
                    {m.author && m.author !== 'harness' && <span className="faint mono"> · author: {m.author}</span>}
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

/** U-shaped positional attention heat (Lost in the middle, simulated): lower attention in the middle */
function uHeat(pos: number, n: number): number {
  if (n <= 1) return 1
  const x = pos / (n - 1)
  const u = 1 - 0.72 * (1 - Math.abs(2 * x - 1) ** 1.6)
  return u
}
function heatColor(v: number): string {
  // v in (0,1], higher is greener (higher attention), lower is redder
  const hue = v * 120
  return `hsl(${hue}, 65%, 42%)`
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
    return vis[vis.length - 1] ?? null
  }, [run, playhead])

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

  if (!run || !cur) return <div className="panel"><h3>{t('mri.stack.title2')}</h3><div className="faint">Awaiting playback…</div></div>

  const n = cur.blocks.length
  const total = cur.estTokens
  const scenarioTraps = meta?.traps ?? []

  return (
    <div className="panel scrollable">
      <div>
        <h3>
          {t('mri.stack.title2')} <span className="tag">{t('mri.step.what', { step: cur.step })}</span>
          <span style={{ float: 'right' }} className="mono" title="Total tokens for this step">{fmtTokens(total)} tk</span>
        </h3>
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
              {b.preview && <span className="faint" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.preview}</span>}
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <h3>{t('mri.shaper.title')} <span className="tag">{t('mri.shaper.tag')}</span></h3>
        <div className="shaper-stage">
          {(['budget', 'snip', 'microcompact', 'contextCollapse', 'autoCompact'] as const).map((name, i) => {
            const fire = shapers.find((f) => f.type === 'shaper.fire' && f.shaper === name)
            const lit = !!fire
            return (
              <div key={name} className={`shaper-row ${lit ? 'lit' : ''}`}>
                <span className="ord">{i + 1}</span>
                <span className="nm">{t(`mri.shaper.${name}`) !== `mri.shaper.${name}` ? t(`mri.shaper.${name}`) : SHAPER_LABEL[name]}</span>
                <span className="ds">{[t('mri.shaper.desc0'), t('mri.shaper.desc1'), t('mri.shaper.desc2'), t('mri.shaper.desc3'), t('mri.shaper.desc4')][i]}</span>
                <span className="fr">{lit && fire!.type === 'shaper.fire' ? fire!.freedTokens : '—'}</span>
              </div>
            )
          })}
        </div>
        {shapers.length === 0 && <div className="faint" style={{ marginTop: 6 }}>{t('mri.shaper.empty')}</div>}
      </div>
    </div>
  )
}
