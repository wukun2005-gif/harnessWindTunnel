// 实测分析视图（M1 §17.9）：只回答“该不该启用 Jev”。
// 数据源为落盘 A/B 记录；聚合现算；每指标一行结论色 + 一句话解读 + 可下钻。
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import { getBatchSnapshot, resetBatch, subscribeBatch } from './batchRunner'
import type { EvalTask } from '../../../shared/playground'
import type { JevReviewRecord } from '../../../shared/jev'
import {
  GATES,
  agreementBySource,
  agreementStats,
  calibrationBuckets,
  calibrationConservative,
  calibrationStatus,
  confidenceStats,
  costStats,
  driftStats,
  injectionStats,
  overallVerdict,
  trapStats,
  type VerdictReason,
} from './analysis'

function pct(v: number | null): string {
  return v == null ? '—' : `${Math.round(v * 100)}%`
}

function confPct(c: number | null): string {
  return c == null ? '—' : `${Math.round(c * 100)}%`
}

function stateColor(pass: boolean | null): string {
  if (pass == null) return 'var(--dim)'
  return pass ? 'rgba(80,180,120,0.15)' : 'rgba(200,170,60,0.20)'
}

export default function AnalysisPanel({ tasks }: { tasks: EvalTask[] }) {
  const t = useT()
  const [records, setRecords] = useState<JevReviewRecord[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [batch, setBatch] = useState<string | null>(null)
  const [clearing, setClearing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // 一键实测跑批中不许删批：跑批会持续往当前批次追加记录。
  const [running, setRunning] = useState(() => getBatchSnapshot().running)
  useEffect(() => subscribeBatch(() => setRunning(getBatchSnapshot().running)), [])

  useEffect(() => {
    let live = true
    api
      .pgJevReviews({ limit: 10_000 })
      .then((r) => {
        if (live) setRecords(r)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  const batches = useMemo(() => {
    if (!records) return []
    const m = new Map<string, { count: number; latest: string; scenario: string }>()
    for (const r of records) {
      if (!r.batchId) continue
      const e = m.get(r.batchId) ?? { count: 0, latest: '', scenario: r.scenario ?? 'playground' }
      e.count++
      if (r.time > e.latest) e.latest = r.time
      m.set(r.batchId, e)
    }
    return [...m.entries()].sort((a, b) => (a[1].latest < b[1].latest ? 1 : -1))
  }, [records])
  const activeBatch = batch ?? (batches.length > 0 ? batches[0]![0] : null)

  const scoped = useMemo(
    () => (records == null || activeBatch == null ? [] : records.filter((r) => r.batchId === activeBatch)),
    [records, activeBatch],
  )
  const trapIds = useMemo(() => new Set(tasks.filter((x) => x.injectionTrap).map((x) => x.id)), [tasks])
  const scenarioCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of scoped) {
      const s = r.scenario ?? 'playground'
      m.set(s, (m.get(s) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [scoped])
  const scenarioName = (s: string, n: number): string => {
    const k = `playground.batch.scenario.${s}`
    const v = t(k, { n })
    return v === k ? `${s} (${n})` : v
  }
  const recallIds = useMemo(
    () => new Set(tasks.filter((x) => x.injectionTrap && x.badAnswerKind === 'injection-obeyed').map((x) => x.id)),
    [tasks],
  )

  const agree = useMemo(() => agreementStats(scoped), [scoped])
  const drift = useMemo(() => driftStats(scoped), [scoped])
  const buckets = useMemo(() => calibrationBuckets(scoped), [scoped])
  const calib = useMemo(() => calibrationStatus(buckets), [buckets])
  const calibNote = useMemo(() => calibrationConservative(buckets), [buckets])
  const bySource = useMemo(() => agreementBySource(scoped), [scoped])
  const conf = useMemo(() => confidenceStats(scoped), [scoped])
  const cost = useMemo(() => costStats(scoped), [scoped])
  const trap = useMemo(() => trapStats(scoped, trapIds), [scoped, trapIds])
  const inj = useMemo(() => injectionStats(scoped, recallIds), [scoped, recallIds])
  // 场景适用性：本批没有 trap 题 → 注入鲁棒性不适用（写「不适用」，不是「待测」）。
  const injectionNa = trap.total === 0
  // 一致率的比对基准按批内实况定：全是「无确定性判分」的记录（RAG/标签/断言）比的是金标，指标名随实改名。
  const vsGold = scoped.length > 0 && scoped.every((r) => r.result.success == null)
  const verdict = useMemo(
    () => overallVerdict({ total: scoped.length, drift, agreement: agree, calib, trapTotal: trap.total, injection: inj.status }),
    [scoped.length, drift, agree, calib, trap.total, inj.status],
  )

  /** verdict 标签显示：四类走文案，五类等场景标签原样回显。 */
  const jevLabel = (c: string): string => {
    const k = `playground.jev.choice.${c}`
    const v = t(k)
    return v === k ? c : v
  }

  const reasonText = (r: VerdictReason): string => {
    switch (r.code) {
      case 'insufficient':
        return t('playground.analysis.reason.insufficient', { n: r.n ?? 0 })
      case 'no-comparable':
        return t('playground.analysis.reason.noComparable')
      case 'drift':
        return t('playground.analysis.reason.drift', { pct: r.pct ?? '' })
      case 'agreement':
        return t('playground.analysis.reason.agreement', { pct: r.pct ?? '' })
      case 'calibration':
        return t('playground.analysis.reason.calibration')
      case 'injection-fail':
        return t('playground.analysis.reason.injectionFail')
      case 'injection-unmeasured':
        return t('playground.analysis.reason.injection')
    }
  }

  /** 删除当前选中的批次落盘记录（服务端按批次清），本地同步剔除并把下拉切到下一批。 */
  const deleteBatch = async () => {
    if (!activeBatch || clearing || running) return
    const n = batches.find(([bid]) => bid === activeBatch)?.[1].count ?? scoped.length
    if (!window.confirm(t('playground.analysis.confirmBatch', { n, id: activeBatch.slice(0, 8) }))) return
    setClearing(true)
    setNotice(null)
    try {
      const r = await api.pgClearJevReviews({ batchId: activeBatch })
      setRecords((prev) => (prev ?? []).filter((x) => x.batchId !== activeBatch))
      // 下拉落到最近一批；C 页签若正摊着这批的内存小结，一并清掉，避免显示已删记录。
      setBatch(null)
      const memo = getBatchSnapshot()
      if (!memo.running && memo.batchId === activeBatch) resetBatch()
      setNotice(t('playground.analysis.deleted', { n: r.deleted }))
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : String(e)))
    } finally {
      setClearing(false)
    }
  }

  if (failed) return <div className="panel loading">{t('playground.loadFail')}</div>
  if (records == null) return <div className="panel loading">{t('playground.loading')}</div>
  if (batches.length === 0) return <div className="panel loading">{t('playground.analysis.empty')}</div>

  const verdictBg =
    verdict.state === 'enable'
      ? 'rgba(80,180,120,0.12)'
      : verdict.state === 'disable'
        ? 'rgba(200,90,90,0.12)'
        : 'rgba(200,170,60,0.12)'

  return (
    <div className="panel" style={{ padding: 16 }}>
      <h3 style={{ margin: '0 0 4px' }}>{t('playground.analysis.title')}</h3>
      <p className="faint" style={{ marginTop: 0 }}>{t('playground.analysis.desc')}</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span className="faint">{t('playground.analysis.batch')}</span>
          <select value={activeBatch ?? ''} onChange={(e) => setBatch(e.target.value || null)} style={{ padding: 4, fontSize: 12 }}>
            {batches.map(([bid, info]) => (
              <option key={bid} value={bid}>
                {t('playground.analysis.batchOption', { id: bid.slice(0, 8), n: info.count, scenario: info.scenario })}
              </option>
            ))}
          </select>
          <span className="faint">n={scoped.length}</span>
        </label>
        <button
          style={{ fontSize: 12, padding: '4px 10px' }}
          onClick={() => void deleteBatch()}
          disabled={clearing || running || activeBatch == null}
          title={running ? t('playground.batch.running') : undefined}
        >
          {clearing ? t('playground.analysis.deleting') : t('playground.analysis.deleteBatch')}
        </button>
        {notice && <span className="faint" style={{ fontSize: 12 }}>{notice}</span>}
      </div>
      {scenarioCounts.length > 0 && (
        <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}>
          {scenarioCounts.map(([s, n]) => scenarioName(s, n)).join(' · ')}
        </div>
      )}

      <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, background: verdictBg }}>
        <b style={{ fontSize: 13 }}>{t('playground.analysis.verdict')}: {t(`playground.analysis.verdict.${verdict.state}`)}</b>
        {verdict.reasons.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
            {verdict.reasons.map((r, i) => (
              <li key={i}>{reasonText(r)}</li>
            ))}
          </ul>
        )}
      </div>

      <div style={{ display: 'grid', gap: 8, fontSize: 12 }}>
        <div style={{ padding: 8, borderRadius: 6, background: stateColor(agree.rate == null ? null : agree.rate >= GATES.agreementMin) }}>
          <b>{t(vsGold ? 'playground.analysis.m.agreementGold' : 'playground.analysis.m.agreement')}: {agree.rate == null ? t('playground.analysis.state.unknown') : pct(agree.rate)}</b>
          <span className="faint">
            {' '}
            {Object.entries(agree.byDomain)
              .map(([d, s]) => t('playground.analysis.byDomain', { domain: t(`playground.domain.${d}`), agree: s.agree, total: s.total }))
              .join(' · ')}
          </span>
          {agree.divergent.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>{t('playground.analysis.divergentTitle')}</summary>
              <div className="faint">
                {agree.divergent.slice(0, 20).map((d) => {
                  // 点回单条复核（§17.9）：按记录 id 联查本批记录，原位展开复核卡。
                  const rec = scoped.find((r) => r.id === d.id)
                  const jev = d.jev == null ? t('playground.jev.noReading') : jevLabel(d.jev)
                  const gold = Array.isArray(d.gold) ? d.gold.join(', ') : d.gold
                  // 比对基准随实：有确定性判分写「官方=」；比金标的写「金标=」，不再显示「官方=无」。
                  const line =
                    d.det != null
                      ? t('playground.analysis.divergentLine', { task: d.taskId, jev, det: d.det ? t('playground.report.pass') : t('playground.report.fail') })
                      : gold != null
                        ? t('playground.analysis.divergentLineGold', { task: d.taskId, jev, gold: jevLabel(gold) })
                        : t('playground.analysis.divergentLine', { task: d.taskId, jev, det: t('playground.analysis.none') })
                  return (
                    <details key={d.id} style={{ marginTop: 2 }}>
                      <summary style={{ cursor: 'pointer' }}>{line}</summary>
                      {rec && (
                        <div style={{ marginLeft: 8, paddingLeft: 8, borderLeft: '2px solid rgba(255,255,255,0.15)' }}>
                          <div>{t('playground.analysis.reviewTime', { time: rec.time.slice(0, 16).replace('T', ' ') })}</div>
                          <div>{t('playground.analysis.reviewMeta', { scenario: rec.scenario ?? 'playground', kind: rec.kind ? t(`playground.batch.kind.${rec.kind}`) : t('playground.analysis.none') })}</div>
                          <div>
                            {t('playground.analysis.reviewAnswer')}{' '}
                            <span style={{ whiteSpace: 'pre-wrap' }}>{rec.answer}</span>
                          </div>
                          <div>{t('playground.analysis.reviewGold', { gold: rec.gold ? jevLabel(Array.isArray(rec.gold) ? rec.gold.join(', ') : rec.gold) : t('playground.analysis.none') })}</div>
                          <div>
                            {t('playground.analysis.reviewReadings', {
                              choice: rec.result.choice ? jevLabel(rec.result.choice.choice) : t('playground.jev.noReading'),
                              choiceConf: confPct(rec.result.choice?.confidence ?? null),
                              score: rec.result.agreement ? String(rec.result.agreement.score) : t('playground.jev.noReading'),
                              scoreConf: confPct(rec.result.agreement?.confidence ?? null),
                            })}
                          </div>
                          <div>
                            {t(`playground.jev.source.${rec.result.source}`)}
                            {rec.result.reason ? ` · ${rec.result.reason}` : ''}
                          </div>
                          <div>
                            {t('playground.analysis.reviewReason')} {rec.result.consistencyDetail || t('playground.analysis.none')}
                          </div>
                        </div>
                      )}
                    </details>
                  )
                })}
                {agree.divergent.length > 20 && <div>…</div>}
              </div>
            </details>
          )}
        </div>

        <div style={{ padding: 8, borderRadius: 6, background: stateColor(drift.rate == null ? null : drift.rate <= GATES.driftMax) }}>
          <b>{t('playground.analysis.m.drift')}: {drift.rate == null ? t('playground.analysis.state.unknown') : pct(drift.rate)}</b>
          {drift.driftedKeys.length > 0 && (
            <details style={{ marginTop: 4 }}>
              <summary style={{ cursor: 'pointer' }}>{t('playground.analysis.drifted', { n: drift.driftedKeys.length })}</summary>
              <div className="faint">
                {drift.driftedKeys
                  .map((k) => {
                    // 键形 题:答案档[:变体]：变体缺省不补占位后缀，答案档翻成屏上用词。
                    const [task, kind, variant] = k.split(':')
                    const kindLabel = kind === 'good' || kind === 'bad' ? t(`playground.batch.kind.${kind}`) : kind
                    return variant ? `${task}:${kindLabel}:${variant}` : `${task}:${kindLabel}`
                  })
                  .join(', ')}
              </div>
            </details>
          )}
        </div>

        <div style={{ padding: 8, borderRadius: 6, background: stateColor(calib === 'unknown' ? null : calib === 'pass') }}>
          <b>{t('playground.analysis.m.calibration')}: {t(`playground.analysis.state.${calib}`)}</b>
          {calibNote && <span className="faint"> · {t('playground.analysis.calibConservative')}</span>}
          <div className="faint" style={{ marginTop: 2, fontSize: 11 }}>{t('playground.analysis.calibGateLines')}</div>
          <div style={{ marginTop: 4 }}>
            {buckets.map((b) => (
              <div key={`${b.lo}-${b.hi}`} className="faint">
                {t('playground.analysis.bucket', {
                  lo: Math.round(b.lo * 100),
                  hi: Math.round(b.hi * 100),
                  agree: b.agree,
                  n: b.n,
                  pct: pct(b.rate),
                })}
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: 8, borderRadius: 6, background: injectionNa ? 'var(--dim)' : inj.status === 'fail' ? 'rgba(200,90,90,0.12)' : stateColor(inj.status === 'unknown' ? null : inj.status === 'pass') }}>
          <b>{t('playground.analysis.m.injection')}: {injectionNa ? t('playground.analysis.na') : t(`playground.analysis.state.${inj.status === 'unknown' ? 'unknown' : inj.status}`)}</b>
          {injectionNa ? (
            <div className="faint" style={{ marginTop: 4 }}>
              {t('playground.analysis.injectionNa')}
            </div>
          ) : (
            <>
          <div className="faint" style={{ marginTop: 4 }}>
            {t('playground.analysis.trapLine', { total: trap.total, agree: trap.agree, bypass: trap.bypass })}
          </div>
          <div className="faint" style={{ marginTop: 4 }}>
            {t('playground.analysis.injPairs', { n: inj.pairs })}
            {' · '}
            {inj.changeRate == null
              ? t('playground.analysis.state.unknown')
              : t('playground.analysis.injChange', { changed: inj.changed, pairs: inj.pairs, pct: `${Math.round(inj.changeRate * 100)}%` })}
            {' · '}
            {inj.recall == null
              ? t('playground.analysis.state.unknown')
              : t('playground.analysis.injRecall', { hit: inj.recallHit, total: inj.recallTotal, pct: `${Math.round(inj.recall * 100)}%` })}
          </div>
          {inj.status === 'unknown' && <div className="faint" style={{ marginTop: 4 }}>{t('playground.analysis.reason.injection')}</div>}
            </>
          )}
        </div>

        <div style={{ padding: 8, borderRadius: 6, background: 'var(--dim)' }}>
          <b>{t('playground.analysis.m.sources')}</b>
          <div className="faint" style={{ marginTop: 4 }}>
            {bySource.length > 0 ? bySource.map((s) => (
              <div key={s.source}>
                {t('playground.analysis.sourceLine', { source: s.source, agree: s.agree, judged: s.judged, total: s.total })}
              </div>
            )) : t('playground.analysis.none')}
            <div>
              {conf.avg == null
                ? t('playground.analysis.none')
                : t('playground.analysis.confLine', {
                    avg: conf.avg.toFixed(2),
                    max: conf.max!.toFixed(2),
                    min: conf.min!.toFixed(2),
                    pct: conf.total > 0 ? `${Math.round((conf.hit / conf.total) * 100)}%` : '—',
                  })}
            </div>
          </div>
        </div>

        <div style={{ padding: 8, borderRadius: 6, background: 'var(--dim)' }}>
          <b>{t('playground.analysis.m.cost')}</b>
          <span className="faint">
            {' '}
            {cost.avgTokens == null
              ? t('playground.analysis.none')
              : t('playground.analysis.costLine', { avg: cost.avgTokens, p50: cost.p50 ?? '—', p95: cost.p95 ?? '—' })}
          </span>
        </div>
      </div>
    </div>
  )
}
