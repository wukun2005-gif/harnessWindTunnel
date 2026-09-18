import { useEffect, useState } from 'react'
import { useApp, useDemo, useForge, useRun, useTunnel } from '../../stores'
import { api } from '../../api'
import { PRESETS } from '../../../shared/presets'
import { fmtTokens } from '../../lib/derive'
import { useT, useVariantLabel } from '../../i18n'
import { ScreenNav } from '../../components/ScreenNav'

export interface DemoStepDef {
  screen: string
  titleKey: string
  descKey: string
  memoryKey: string
}

export const DEMO_STEPS: DemoStepDef[] = [
  { screen: 'Opening', titleKey: 'demo.step1.title', descKey: 'demo.step1.desc', memoryKey: 'demo.step1.memory' },
  { screen: 'Run Insight', titleKey: 'demo.step2.title', descKey: 'demo.step2.desc', memoryKey: 'demo.step2.memory' },
  { screen: 'Run Insight', titleKey: 'demo.step3.title', descKey: 'demo.step3.desc', memoryKey: 'demo.step3.memory' },
  { screen: 'Run Insight', titleKey: 'demo.step4.title', descKey: 'demo.step4.desc', memoryKey: 'demo.step4.memory' },
  { screen: 'Wind Tunnel', titleKey: 'demo.step5.title', descKey: 'demo.step5.desc', memoryKey: 'demo.step5.memory' },
  { screen: 'Wind Tunnel', titleKey: 'demo.step6.title', descKey: 'demo.step6.desc', memoryKey: 'demo.step6.memory' },
  { screen: 'Wind Tunnel', titleKey: 'demo.step7.title', descKey: 'demo.step7.desc', memoryKey: 'demo.step7.memory' },
  { screen: 'Wind Tunnel', titleKey: 'demo.step8.title', descKey: 'demo.step8.desc', memoryKey: 'demo.step8.memory' },
  { screen: 'Evolution', titleKey: 'demo.step9.title', descKey: 'demo.step9.desc', memoryKey: 'demo.step9.memory' },
  { screen: 'Evolution', titleKey: 'demo.step10.title', descKey: 'demo.step10.desc', memoryKey: 'demo.step10.memory' },
  { screen: 'Evolution', titleKey: 'demo.step11.title', descKey: 'demo.step11.desc', memoryKey: 'demo.step11.memory' },
  { screen: 'Evolution', titleKey: 'demo.step12.title', descKey: 'demo.step12.desc', memoryKey: 'demo.step12.memory' },
]

function enterMRI(scenarioId: string, branchId: string) {
  useApp.getState().select(scenarioId)
  void useRun.getState().load(scenarioId, branchId).then(() => { location.hash = '#/insight' })
}

function enterTunnel() {
  const p = PRESETS[0]
  useApp.getState().select(p.scenarioId)
  useTunnel.getState().loadPresetVariants(p.scenarioId, p.variants)
  location.hash = '#/tunnel'
}

function enterForge() {
  useForge.getState().reset()
  location.hash = '#/evolution'
}

export default function Demo() {
  const { step, next, prev, setStep } = useDemo()
  const def = DEMO_STEPS[step]
  const t = useT()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next() }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prev() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, prev])

  // Preset states for all steps
  useDemoPrepare()

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">{t('demo.screen.intro')}</span>
        <h1>{t('demo.title')}</h1>
        <span className="q">{t('demo.hint.keys', { step: step + 1 })}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={prev} disabled={step === 0}>{t('demo.prev')}</button>
          <button className="primary" onClick={next} disabled={step === 11}>{t('demo.next')}</button>
        </div>
      </div>
      <ScreenNav current="/demo" />
      <div className="demo-layout">
        <div className="panel">
          <h3>{t('demo.checklist')}</h3>
          {DEMO_STEPS.map((d, i) => (
            <div key={i} className={`demo-step ${i === step ? 'cur' : ''}`} onClick={() => setStep(i)}>
              <span className="n">{String(i + 1).padStart(2, '0')}</span>
              <div>
                <div className="t">{t(d.titleKey)}</div>
                <div className="d">{d.screen} · {t('demo.hook')}: {t(d.memoryKey)}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="panel demo-stage">
          <div className="demo-kicker">{t('demo.detail.step', { step: step + 1, screen: def.screen })}</div>
          <h2 style={{ fontSize: 20, marginBottom: 8 }}>{t(def.titleKey)}</h2>
          <p className="muted" style={{ marginBottom: 18 }}>{t(def.descKey)}</p>
          <StepStage step={step} />
          <div style={{ marginTop: 20, display: 'flex', gap: 10 }}>
            {step >= 1 && step <= 3 && <button onClick={() => enterMRI(step === 3 ? 'research-competitor-scan' : 'writing-q3-report', step === 3 ? 'verifier' : 'fivelayer')}>{t('demo.enter.mri')}</button>}
            {step >= 4 && step <= 7 && <button onClick={enterTunnel}>{t('demo.enter.tunnel')}</button>}
            {step >= 8 && <button onClick={enterForge}>{t('demo.enter.forge')}</button>}
          </div>
        </div>
      </div>
    </div>
  )
}

function useDemoPrepare() {
  const app = useApp()
  const run = useRun()
  const T = useTunnel()
  const F = useForge()

  useEffect(() => {
    if (!app.ready || !app.online) return
    // MRI: load fivelayer (shaper animation material)
    void run.load('writing-q3-report', 'fivelayer').then(() => {
      // Fast-forward past compaction boundary
      const idx = useRun.getState().run?.events.findIndex((e) => e.type === 'compact.boundary') ?? 0
      run.setPlayhead(idx + 7)
    })
    // MRI-2: research verifier rejection material
    // Wind Tunnel: load NLAH preset with 4 configs
    const p = PRESETS[0]
    T.loadPresetVariants(p.scenarioId, p.variants)
    // Forge: reset to Gen1
    F.reset()
    void api.forge().catch(() => undefined)
  }, [app.ready, app.online]) // eslint-disable-line react-hooks/exhaustive-deps
}

function StepStage({ step }: { step: number }) {
  const label = useVariantLabel()
  const app = useApp()
  const run = useRun()
  const T = useTunnel()
  const F = useForge()
  const forge = app.forge
  const t = useT()

  // ---- Step 1: Opening 34 vs 77 ----
  if (step === 0) {
    const coding = app.metas['coding-terminal-refactor']
    return (
      <div>
        <div className="big-vs">
          <div className="side">
            <div className="pct" style={{ color: 'var(--red)' }}>34%</div>
            <div className="cap">{t('demo.bare.harness')}<br /><span className="faint mono">premature-victory ×1</span></div>
          </div>
          <div className="vs">{t('demo.vs')}</div>
          <div className="side">
            <div className="pct" style={{ color: 'var(--green)' }}>77%</div>
            <div className="cap">{t('demo.tuned.harness')}<br /><span className="faint mono">AHE Final State · arXiv:2604.25850</span></div>
          </div>
        </div>
        <div className="faint" style={{ textAlign: 'center' }}>
          {t('demo.same.model', { model: coding?.model ?? '—', task: coding?.task ?? '—' })}
        </div>
      </div>
    )
  }

  // ---- Steps 2-4: MRI Materials ----
  if (step >= 1 && step <= 3) {
    if (step === 1) {
      const shapers = (() => {
        const evs = run.run?.events ?? []
        return evs.filter((e) => e.type === 'shaper.fire')
      })()
      const compactEv = run.run?.events.find((e) => e.type === 'compact.boundary') as { afterTokens: number } | undefined
      return (
        <div className="shaper-stage">
          {(['budget', 'snip', 'microcompact', 'contextCollapse', 'autoCompact'] as const).map((name, i) => {
            const fire = shapers.find((f) => f.type === 'shaper.fire' && f.shaper === name)
            return (
              <div key={name} className={`shaper-row ${fire ? 'lit' : ''}`}>
                <span className="ord">{i + 1}</span>
                <span className="nm">{t(`mri.shaper.${name}`) !== `mri.shaper.${name}` ? t(`mri.shaper.${name}`) : name}</span>
                <span className="ds">{[t('demo.shaper.single'), t('demo.shaper.trim'), t('demo.shaper.cache'), t('demo.shaper.collapse'), t('demo.shaper.semantic')][i]}</span>
                <span className="fr">{fire && fire.type === 'shaper.fire' ? fire.freedTokens : '—'}</span>
              </div>
            )
          })}
          <div className="faint" style={{ marginTop: 8 }}>{t('demo.shaper.report', { before: '14.8k', after: compactEv?.afterTokens ?? '—' })}</div>
        </div>
      )
    }
    if (step === 2) {
      const steps = run.run?.steps ?? []
      const cur = steps.find((s) => s.tools.some((t) => t.tool === 'fs.read' && (t.tokens ?? 0) > 3000)) ?? steps[steps.length - 1]
      if (!cur) return <div className="faint">{t('demo.step.load')}</div>
      const total = cur.estTokens
      return (
        <div>
          <div className="stack-bar">
            {cur.blocks.map((b, i) => (
              <div key={i} className={`stack-seg lyr-${b.layer}`} style={{ flex: Math.max(b.tokens / total, 0.012) }} title={`${b.layer} · ${b.sourceComponent} · ${b.tokens}tk`}>
                {b.tokens / total > 0.12 && <span className="tk">{fmtTokens(b.tokens)}</span>}
              </div>
            ))}
          </div>
          <div className="stack-rows" style={{ marginTop: 10 }}>
            {cur.blocks.map((b, i) => (
              <div key={i} className="stack-row">
                <span className="lyr">{b.layer}</span>
                <span className="src">{b.sourceComponent}</span>
                <span className="tk">{fmtTokens(b.tokens)}</span>
              </div>
            ))}
          </div>
          <div className="faint" style={{ marginTop: 8 }}>{t('demo.mri.perspective')}</div>
        </div>
      )
    }
    // step 3: verifier reject → load research branch
    return <VerifierRejectMini />
  }

  // ---- Steps 5-8: Wind Tunnel Materials ----
  if (step >= 4 && step <= 7) {
    const rows = T.variants.map((v) => ({ v, m: T.metrics[v.key] }))
    if (step === 4 || step === 5) {
      return (
        <div>
        <table className="t">
          <thead><tr><th>{t('demo.config')}</th><th className="num">{t('demo.success.rate')}</th><th className="num">Δ</th><th>{t('demo.failure.modes')}</th></tr></thead>
          <tbody>
            {rows.map(({ v, m }, i) => {
              const base = rows[0]?.m
              const d = m && base ? m.successRate - base.successRate : 0
              return (
                <tr key={v.key}>
                  <td><span style={{ color: v.color }}>■</span> {label(v.label)}<div className="faint">{v.note}</div></td>
                  <td className="num">{m ? `${m.successRate.toFixed(1)}%` : '…'}</td>
                  <td className={`num ${d > 0.05 ? 'delta-pos' : d < -0.05 ? 'delta-neg' : ''}`}>{m && base && i > 0 ? `${d >= 0 ? '+' : ''}${d.toFixed(1)}pp` : ''}</td>
                  <td>{m && Object.entries(m.failureModes).map(([k, c]) => <span key={k} className="tl-mark mk-fail" style={{ position: 'static', display: 'inline-block', transform: 'none', marginRight: 4 }}>{k}</span>)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="faint" style={{ marginTop: 8 }}>{t('demo.wind.gloss')}</div>
        </div>
      )
    }
    if (step === 6) {
      return (
        <div className="faint" style={{ textAlign: 'center', padding: '40px 0' }}>
          <div style={{ fontSize: 44, marginBottom: 10 }}>⑂</div>
          {t('demo.traj.diff')}
          <div style={{ marginTop: 8 }}>{t('demo.traj.detail')}</div>
          <div style={{ marginTop: 14 }}><button className="primary" onClick={enterTunnel}>{t('demo.enter.tunnel.diff')}</button></div>
        </div>
      )
    }
    // step 7 (index): Failure modes matrix
    const modes = new Set<string>()
    rows.forEach((r) => Object.keys(r.m?.failureModes ?? {}).forEach((k) => modes.add(k)))
    return (
      <table className="t">
        <thead><tr><th>{t('demo.failure.modes')}</th>{rows.map(({ v }) => <th key={v.key} className="num">{label(v.label)}</th>)}</tr></thead>
        <tbody>
          {[...modes].map((k) => (
            <tr key={k}>
              <td className="mono" style={{ color: 'var(--red)' }}>{k}</td>
              {rows.map(({ v, m }) => {
                const c = m?.failureModes[k] ?? 0
                return <td key={v.key} className="num" style={{ background: c ? `rgba(248,113,113,${0.06 + 0.13 * c})` : undefined }}>{c || '·'}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  // ---- Steps 9-12: Forge Materials ----
  if (!forge) return <div className="faint">{t('demo.loading.forge')}</div>
  const gen = forge.gens.find((g) => g.gen === F.currentGen) ?? forge.gens[0]
  if (step === 8) {
    return (
      <div style={{ border: '1px solid rgba(248,113,113,.35)', background: 'rgba(248,113,113,.06)', borderRadius: 12, padding: 18, textAlign: 'center' }}>
        <div className="mono" style={{ color: 'var(--red)', fontSize: 20 }}>premature-victory ×{gen.cluster.count}</div>
        <div className="muted" style={{ margin: '8px 0' }}>{gen.cluster.summary}</div>
        <div className="faint">{t('demo.attributed.to', { branches: gen.cluster.sampleBranches.join(', ') })}</div>
      </div>
    )
  }
  if (step === 9) {
    return (
      <div className="falsify" style={{ maxWidth: 560 }}>
        <div className="cell"><div className="v" style={{ color: 'var(--green)' }}>{gen.falsification.rescued}</div><div className="k">{t('demo.falsify.rescued')}</div></div>
        <div className="cell"><div className="v">{gen.falsification.regressed}</div><div className="k">{t('demo.falsify.regressed')}</div></div>
        <div className="cell"><div className="v" style={{ color: 'var(--accent)' }}>+{(gen.falsification.rescued - gen.falsification.regressed)}</div><div className="k">{t('demo.falsify.net')}</div></div>
        <div className="cell" style={{ gridColumn: '1 / -1', textAlign: 'left' }}>
          <div className="faint">{t('demo.falsify.counter')}</div>
          <div>{t('demo.falsify.predicted')} <b className="mono" style={{ color: 'var(--amber)' }}>+1.0~+1.5pp</b> {t('demo.falsify.empirical')} <b className="mono" style={{ color: 'var(--red)' }}>−6.2pp</b> (41.6% → 35.4%) {t('demo.falsify.rollback')}</div>
        </div>
      </div>
    )
  }
  if (step === 10) {
    return (
      <div className="vtree" style={{ maxWidth: 420 }}>
        <div className="vnode"><span className="g">GEN 0</span><span className="dot2" /><span className="msg">{t('demo.tree.initial')}</span></div>
        {forge.gens.slice(0, Math.max(F.currentGen, 1)).map((g) => (
          <div key={g.gen}>
            <div className={g.verdict === 'rejected' ? 'vline stub' : ''} />
            <div className={`vnode ${g.verdict === 'rejected' ? 'rejected' : ''}`}>
              <span className="g">GEN {g.gen}</span>
              <span className="dot2" />
              <span className="msg">{g.verdict === 'rejected' ? t('demo.tree.rollback', { title: g.card.title }) : t('demo.tree.commit', { gen: String(g.gen).padStart(2, '0'), title: g.card.title })}</span>
              <span className="g">{g.verdict === 'approved' ? `${g.gain >= 0 ? '+' : ''}${g.gain.toFixed(1)}pp` : '+0.0pp'}</span>
            </div>
          </div>
        ))}
        <div className="faint" style={{ marginTop: 8 }}>{t('demo.tree.hint')}</div>
      </div>
    )
  }
  // step 11: autoplay curve
  const W = 620, H = 190, P = 40
  const pts = [0, ...forge.gens.map((g) => g.gen)].map((n) => ({
    g: n,
    s: forge.startScore + forge.gens.filter((x) => x.gen <= n && x.verdict === 'approved').reduce((a, x) => a + x.gain, 0),
  }))
  const px = (g: number) => P + (g / forge.gens.length) * (W - P - 16)
  const py = (s: number) => H - P - ((s - 68) / (79 - 68)) * (H - P - 20)
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }}>
      <line x1={P} y1={H - P} x2={W - 10} y2={H - P} stroke="var(--border-hi)" />
      <line x1={P} y1={14} x2={P} y2={H - P} stroke="var(--border-hi)" />
      {[70, 74, 77].map((v) => <g key={v}><line x1={P} y1={py(v)} x2={W - 10} y2={py(v)} stroke="var(--border)" strokeDasharray="3 4" /><text x={P - 6} y={py(v) + 3} textAnchor="end" fill="var(--text-faint)" fontSize="10">{v}</text></g>)}
      <polyline fill="none" stroke="var(--accent)" strokeWidth="2.5" points={pts.map((p) => `${px(p.g)},${py(p.s)}`).join(' ')} />
      {pts.map((p) => (
        <g key={p.g}>
          <circle cx={px(p.g)} cy={py(p.s)} r={4} fill="var(--accent)" />
          <text x={px(p.g)} y={py(p.s) - 9} textAnchor="middle" fill="var(--text-dim)" fontSize="10">{p.s.toFixed(1)}</text>
          <text x={px(p.g)} y={H - P + 14} textAnchor="middle" fill="var(--text-faint)" fontSize="10">G{p.g}</text>
        </g>
      ))}
      <text x={W - 14} y={20} textAnchor="end" fill="var(--text-faint)" fontSize="11">{t('demo.curve.stop')}</text>
    </svg>
  )
}

function VerifierRejectMini() {
  const [events, setEvents] = useState<import('../../../shared/events').HarnessEvent[] | null>(null)
  const t = useT()
  useEffect(() => {
    void api.replayBranch('research-competitor-scan', 'verifier').then((r) => setEvents(r.events as never))
  }, [])
  const rej = events?.find((e) => e.type === 'verifier.verdict' && e.verdict === 'reject')
  const pass = events?.find((e) => e.type === 'verifier.verdict' && e.verdict === 'pass')
  if (!events) return <div className="faint">{t('demo.loading.branch')}</div>
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {rej && rej.type === 'verifier.verdict' && (
        <div style={{ border: '1px solid rgba(248,113,113,.4)', background: 'rgba(248,113,113,.07)', borderRadius: 12, padding: '14px 18px' }}>
          <span className="tl-mark mk-verifier-reject" style={{ position: 'static', display: 'inline-block', transform: 'none' }}>Verifier Rejected</span>
          <div style={{ marginTop: 6, color: 'var(--text-dim)' }}>{rej.reason}</div>
        </div>
      )}
      {pass && pass.type === 'verifier.verdict' && (
        <div style={{ border: '1px solid rgba(52,211,153,.4)', background: 'rgba(52,211,153,.06)', borderRadius: 12, padding: '14px 18px' }}>
          <span className="tl-mark mk-verifier-pass" style={{ position: 'static', display: 'inline-block', transform: 'none' }}>Verifier Passed</span>
          <div style={{ marginTop: 6, color: 'var(--text-dim)' }}>{pass.reason}</div>
        </div>
      )}
      <div className="faint">{t('demo.same.task')}</div>
    </div>
  )
}
