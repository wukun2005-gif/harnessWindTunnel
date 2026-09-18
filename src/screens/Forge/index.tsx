import { useMemo, useState } from 'react'
import { MAST_LABEL } from '../../../shared/mast'
import { useApp, useForge } from '../../stores'
import type { ForgeGen } from '../../api'
import { SourceBadge } from '../MRI'
import { useT, useFixture } from '../../i18n'
import { downloadJson } from '../../lib/pack'
import { ScreenNav } from '../../components/ScreenNav'

export default function Forge() {
  const { forge, metas } = useApp()
  const F = useForge()
  const [packOf, setPackOf] = useState<ForgeGen | null>(null)
  const t = useT()
  const f = useFixture()

  if (!forge) return <div className="page"><div className="loading">{t('forge.loading')}</div></div>

  const gen = forge.gens.find((g) => g.gen === F.currentGen) ?? forge.gens[0]
  const haltedGen = !F.autoplay && F.haltedAt != null ? forge.gens.find((g) => g.gen === F.haltedAt) ?? null : null
  const decided = (g: ForgeGen) => F.decisions[g.gen] ?? (g.gen < F.currentGen || F.autoplay && g.gen < F.currentGen ? (g.verdict === 'rejected' ? 'rejected' : g.gen < F.currentGen ? 'approved' : undefined) : undefined)
  const verdictOf = (g: ForgeGen): 'approved' | 'rejected' | 'pending' => {
    const d = F.decisions[g.gen]
    if (d) return d
    return g.gen < F.currentGen ? g.verdict : 'pending'
  }
  const decision = F.decisions[gen.gen]

  const tree = useMemo(() => {
    const nodes: { gen: number; msg: string; kind: 'commit' | 'rejected' | 'rollback' }[] = []
    for (const g of forge.gens) {
      const v = F.decisions[g.gen] ?? (g.gen < F.currentGen ? g.verdict : 'pending')
      if (v === 'approved') nodes.push({ gen: g.gen, msg: g.card.title, kind: 'commit' })
      else if (v === 'rejected') nodes.push({ gen: g.gen, msg: t('forge.rollback.point', { gen: g.gen, title: g.card.title }), kind: 'rollback' })
      else nodes.push({ gen: g.gen, msg: `${g.card.title} (${t('forge.pending.approval')})`, kind: 'rejected' })
    }
    return nodes
  }, [forge, F.decisions, F.currentGen, t])

  const scoreAt = (upTo: number) =>
    forge.startScore + forge.gens.filter((g) => g.gen <= upTo && (F.decisions[g.gen] ?? (g.gen < F.currentGen ? g.verdict : 'pending')) === 'approved').reduce((n, g) => n + g.gain, 0)

  const scenario = metas[forge.scenarioId]

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">SCREEN 03</span>
        <h1>{t('forge.title')}</h1>
        <span className="q">{t('forge.subtitle')}</span>
        <div style={{ marginLeft: 'auto' }}>
          <button className={F.autoplay ? '' : 'primary'} onClick={() => (F.autoplay ? F.setGen(F.currentGen) : F.autoplayTo(forge.gens.length))}>
            {F.autoplay ? t('forge.pause') : t('forge.autoplay')}
          </button>{' '}
          <button onClick={() => F.reset()}>{t('forge.reset')}</button>
          {haltedGen && (
            <span className="faint" style={{ marginLeft: 8 }}>⏸ {t('forge.halt.paused', { gen: haltedGen.gen })} · {haltedGen.falsification.regressed > 0 ? t('forge.halt.regressed') : t('forge.halt.blast', { seam: haltedGen.card.seam })}</span>
          )}
        </div>
      </div>
      <ScreenNav current="/evolution" />

      <div className="grid-forge">
        {/* Left: Failure clusters + generation timeline */}
        <div>
          <div className="panel">
            <h3>{t('forge.failure.clusters')} <span className="tag">{t('forge.failure.clusters.tag')}</span></h3>
            <div className="faint" style={{ marginBottom: 6 }}>{t(`scenario.${forge.scenarioId}.task`) !== `scenario.${forge.scenarioId}.task` ? t(`scenario.${forge.scenarioId}.task`) : scenario?.task}</div>
            <div style={{ border: '1px solid rgba(248,113,113,.35)', background: 'rgba(248,113,113,.06)', borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span className="mono" style={{ color: 'var(--red)' }}>{gen.cluster.mast}</span>
                <span className="mono" style={{ color: 'var(--red)' }}>×{gen.cluster.count}</span>
              </div>
              <div className="faint">{f(MAST_LABEL[gen.cluster.mast as keyof typeof MAST_LABEL])}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 6 }}>{gen.cluster.summary}</div>
              <div className="faint mono" style={{ marginTop: 4 }}>{t('forge.samples')}: {gen.cluster.sampleBranches.join(', ')}</div>
            </div>
          </div>

          <div className="panel">
            <h3>{t('forge.gen.timeline')} <span className="tag">{t('forge.gen.timeline.tag')}</span></h3>
            <div className="gen-list">
              {forge.gens.map((g) => {
                const v = verdictOf(g)
                // Pill shows the EFFECTIVE mainline contribution, not the raw datum:
                // rejected / pending gens contribute 0 no matter what gain is recorded.
                const eff = v === 'approved' ? g.gain : 0
                return (
                  <div key={g.gen} className={`gen-item ${g.gen === F.currentGen ? 'cur' : ''}`} onClick={() => F.setGen(g.gen)}>
                    <span className="g">GEN {g.gen}</span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-dim)' }}>{g.card.title}</span>
                    <span className={`verdict-chip vc-${v}`}>{v === 'pending' ? t('forge.pending') : v}</span>
                    {F.autoDecided[g.gen] && <span className="faint" style={{ fontSize: 10 }} title={t('forge.auto.applied')}>· {t('forge.auto.badge')}</span>}
                    <span className={`gain ${eff > 0 ? 'delta-pos' : eff < 0 ? 'delta-neg' : 'delta-zero'}`}>{eff >= 0 ? '+' : ''}{eff.toFixed(1)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* Center: Change card + falsification + approval gate */}
        <div>
          <div className="panel">
            <h3>{t('forge.change.card')} <span className="tag">· GEN {gen.gen} / {forge.gens.length}</span></h3>
            <div className="change-card">
              <span className="seam">{t('forge.seam', { seam: gen.card.seam })}</span>{' '}
              <span className="seam" title={gen.card.surfaceReason}>{t(`forge.surface.${gen.card.surface}`)}</span>
              <h4>{gen.card.title}</h4>
              <div className="nl">{gen.card.nl}</div>
              <div className="code-diff">{gen.card.diff.split('\n').map((l, i) => (
                <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('~') ? '' : ''} style={{ color: l.startsWith('+') ? 'var(--green)' : l.startsWith('-') ? 'var(--red)' : undefined }}>{l}</div>
              ))}</div>
              <div className="pred-box">
                <span>{t('forge.prediction')}</span>
                <b>+{gen.card.prediction.gainPp[0].toFixed(1)} ~ +{gen.card.prediction.gainPp[1].toFixed(1)}pp</b>
                <span className="faint">{t('forge.falsifiable')}</span>
              </div>
            </div>

            <div className="faint" style={{ margin: '12px 0 4px' }}>{t('forge.falsification.title')}</div>
            <div className="falsify">
              <div className="cell">
                <div className="v" style={{ color: 'var(--green)' }}>{gen.falsification.rescued}</div>
                <div className="k">{t('forge.falsification.rescued')}</div>
              </div>
              <div className="cell">
                <div className="v" style={{ color: gen.falsification.regressed > 0 ? 'var(--red)' : 'var(--text-faint)' }}>{gen.falsification.regressed}</div>
                <div className="k">{t('forge.falsification.regressed')}{gen.falsification.regressed > 0 ? t('forge.falsification.rollback') : ''}</div>
              </div>
              <div className="cell">
                <div className="v" style={{ color: 'var(--accent)' }}>{(gen.falsification.rescued - gen.falsification.regressed) > 0 ? '+' : ''}{gen.falsification.rescued - gen.falsification.regressed}</div>
                <div className="k">{t('forge.falsification.net')}</div>
              </div>
            </div>
            <div className="faint" style={{ marginTop: 6 }}>{gen.falsification.detail}</div>

            <div className="gate">
              <span className="lbl">{t('forge.approval.gate')}</span>
              <button className={decision === 'approved' ? 'active-btn' : ''} onClick={() => { F.decide(gen.gen, 'approved'); if (gen.gen < forge.gens.length) F.setGen(gen.gen + 1) }}>{t('forge.approve')}</button>
              <button className={decision === 'rejected' ? 'danger active-btn' : 'danger'} onClick={() => F.decide(gen.gen, 'rejected')}>{t('forge.reject')}</button>
              <div className="slider-row" style={{ marginLeft: 'auto' }}>
                <span>{t('forge.autonomy.level')}</span>
                <input type="range" min={0} max={2} step={1} value={F.autonomy} onChange={(e) => F.setAutonomy(Number(e.target.value))} list="auto" />
                <span>{t('forge.autonomy.options')}</span>
              </div>
            </div>
            {gen.verdict === 'rejected' && !decision && (
              <div className="faint" style={{ marginTop: 6, color: 'var(--red)' }}>{t('forge.script.hint')}</div>
            )}
          </div>

          <ScoreCurve forge={forge} currentGen={F.currentGen} scoreAt={scoreAt} />
        </div>

        {/* Right: Version tree + Evidence Pack */}
        <div>
          <div className="panel">
            <h3>{t('forge.version.tree')} <span className="tag">{t('forge.version.tree.tag')}</span></h3>
            <div className="vtree">
              <div className="vnode"><span className="g">GEN 0</span><span className="dot2" /><span className="msg">{t('forge.tree.initial', { score: forge.startScore })}</span></div>
              {tree.map((n) => (
                <div key={n.gen}>
                  <div className={n.kind === 'commit' ? '' : 'vline stub'} style={n.kind === 'commit' ? { width: 0, height: 0 } : undefined} />
                  <div className={`vnode ${n.kind === 'commit' ? '' : n.kind === 'rollback' ? 'rollback' : 'rejected'}`} onClick={() => setPackOf(forge.gens.find((g) => g.gen === n.gen) ?? null)}>
                    <span className="g">GEN {n.gen}</span>
                    <span className="dot2" />
                    <span className="msg">{n.kind === 'commit' ? t('forge.tree.commit', { id: `${n.gen < 10 ? 'c0' : 'c'}${n.gen}` }) : n.msg}</span>
                    <span className="g">{n.kind === 'commit' ? `${((forge.gens.find((g) => g.gen === n.gen)?.gain ?? 0) >= 0 ? '+' : '')}${(forge.gens.find((g) => g.gen === n.gen)?.gain ?? 0).toFixed(1)}pp` : ''}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="faint" style={{ marginTop: 8 }}>{t('forge.tree.hint')}</div>
          </div>

          {packOf && (
            <div className="panel">
              <h3>{t('forge.evidence.title')} <span className="tag mono">GEN {packOf.gen}</span></h3>
              <dl className="kv">
                <dt>{t('forge.evidence.cluster')}</dt><dd className="mono" style={{ color: 'var(--red)' }}>{packOf.cluster.mast} ×{packOf.cluster.count}</dd>
                <dt>{t('forge.evidence.seam')}</dt><dd>{packOf.card.seam}</dd>
                <dt>{t('forge.evidence.prediction')}</dt><dd className="mono">+{packOf.card.prediction.gainPp[0]}~+{packOf.card.prediction.gainPp[1]}pp</dd>
                <dt>{t('forge.evidence.falsification')}</dt><dd>{t('forge.evidence.rescued', { rescued: packOf.falsification.rescued })} / {t('forge.evidence.regressed', { regressed: packOf.falsification.regressed })}</dd>
                <dt>{t('forge.verdict')}</dt><dd>{F.decisions[packOf.gen] ?? (packOf.gen < F.currentGen ? packOf.verdict : t('forge.pending'))}</dd>
              </dl>
              <div style={{ marginTop: 8 }}>{forge.source.map((s, i) => <div key={i} style={{ marginTop: 4 }}><SourceBadge source={s as never} /></div>)}</div>
              <div style={{ marginTop: 8 }}>
                <button
                  style={{ padding: '2px 10px', fontSize: 12 }}
                  onClick={() => downloadJson(`evidence-gen${packOf.gen}.json`, { ...packOf, scenarioId: forge.scenarioId, exportedAt: new Date().toISOString() })}
                >{t('forge.evidence.export')}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ScoreCurve({ forge, currentGen, scoreAt }: { forge: NonNullable<ReturnType<typeof useApp.getState>['forge']>, currentGen: number, scoreAt: (n: number) => number }) {
  const t = useT()
  const W = 620, H = 200, P = 40
  const gens = [0, ...forge.gens.map((g) => g.gen)]
  const pts = gens.map((g) => ({ g, s: scoreAt(g) }))
  const yMin = forge.startScore - 2, yMax = forge.endScore + 2
  const px = (g: number) => P + (g / Math.max(1, forge.gens.length)) * (W - P - 16)
  const py = (s: number) => H - P - ((s - yMin) / (yMax - yMin)) * (H - P - 20)
  return (
    <div className="panel">
      <h3>{t('forge.score.curve')} <span className="tag">{t('forge.score.curve.tag')}</span></h3>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }}>
        <line x1={P} y1={H - P} x2={W - 10} y2={H - P} stroke="var(--border-hi)" />
        <line x1={P} y1={14} x2={P} y2={H - P} stroke="var(--border-hi)" />
        {[70, 72, 74, 76].map((v) => (
          <g key={v}>
            <line x1={P} y1={py(v)} x2={W - 10} y2={py(v)} stroke="var(--border)" strokeDasharray="3 4" />
            <text x={P - 6} y={py(v) + 3} textAnchor="end" fill="var(--text-faint)" fontSize="10">{v}</text>
          </g>
        ))}
        <polyline fill="none" stroke="var(--accent)" strokeWidth="2" points={pts.map((p) => `${px(p.g)},${py(p.s)}`).join(' ')} />
        {pts.map((p) => (
          <g key={p.g}>
            <circle cx={px(p.g)} cy={py(p.s)} r={p.g <= currentGen ? 4.5 : 3} fill={p.g <= currentGen ? 'var(--accent)' : 'var(--border-hi)'} />
            <text x={px(p.g)} y={py(p.s) - 9} textAnchor="middle" fill={p.g <= currentGen ? 'var(--text-dim)' : 'var(--text-faint)'} fontSize="10">{p.s.toFixed(1)}</text>
            <text x={px(p.g)} y={H - P + 14} textAnchor="middle" fill="var(--text-faint)" fontSize="10">G{p.g}</text>
          </g>
        ))}
      </svg>
      <div className="faint">{t('forge.score.curve.hint')}</div>
    </div>
  )
}
