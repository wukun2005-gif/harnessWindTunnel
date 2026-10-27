// F7-4 tunnel landing (D9): per-branch trajectory readings under a results /
// trajectory view toggle, plus the "same terminal, different path" pair view.
// Rows stay in branch order — trajectory metrics never re-rank candidates.
import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { useT, useFixture } from '../i18n'
import type { ScenarioMeta } from '../../shared/events'
import type { TrajectoryVerdictResponse } from '../../shared/trajectory'
import { CellBadge, StepVerdictStrip, TrajectorySourceBadge } from './TrajectoryVerdict'
import { Hint } from './Hint'
import { TunnelViewToggle, type TunnelView } from './TunnelViewToggle'

export default function TrajectoryBoard({ meta, view, onView }: {
  meta?: ScenarioMeta
  view: TunnelView
  onView: (view: TunnelView) => void
}) {
  const t = useT()
  const f = useFixture()
  const [list, setList] = useState<TrajectoryVerdictResponse[] | null>(null)
  const [failed, setFailed] = useState(false)
  const branches = useMemo(() => (meta?.branches ?? []).filter((b) => b.file), [meta])

  useEffect(() => {
    let live = true
    setList(null)
    setFailed(false)
    if (!meta) return
    api.trajectoryVerdicts(meta.scenarioId)
      .then((r) => { if (live) setList(r.verdicts) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [meta?.scenarioId]) // eslint-disable-line react-hooks/exhaustive-deps

  const byRun = useMemo(() => new Map((list ?? []).map((x) => [x.verdict.runId, x])), [list])

  // Default pair: two branches with the SAME terminal but DIFFERENT process
  // conclusion (the "same score, different path" demo), else the declared diff
  // pair, else the first two branches.
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  // Scope the default pair to one scenario: switching scenarios must not carry
  // branch ids that do not exist in the new branch list.
  const [pairScenario, setPairScenario] = useState('')
  useEffect(() => {
    if (!list || branches.length < 2 || pairScenario === meta?.scenarioId) return
    const cells = branches.map((b) => byRun.get(`${meta?.scenarioId}#${b.branchId}`)).filter(Boolean) as TrajectoryVerdictResponse[]
    const sameTerminalDiffCell = cells.find(
      (a) => a.verdict.terminalSuccess === true && cells.some((b) => b.verdict.runId !== a.verdict.runId && b.verdict.terminalSuccess === true && b.verdict.cell !== a.verdict.cell),
    )
    const pick = sameTerminalDiffCell ? byRun.get(sameTerminalDiffCell.verdict.runId)! : undefined
    const other = pick
      ? cells.find((b) => b.verdict.runId !== pick.verdict.runId && b.verdict.terminalSuccess === true && b.verdict.cell !== pick.verdict.cell)!
      : undefined
    if (pick && other) {
      setLeft(pick.verdict.runId.split('#')[1])
      setRight(other.verdict.runId.split('#')[1])
    } else {
      const declared = meta?.diffPairs?.[0]
      const okPair = declared && branches.some((b) => b.branchId === declared[0]) && branches.some((b) => b.branchId === declared[1])
      setLeft(okPair ? declared[0] : branches[0].branchId)
      setRight(okPair ? declared[1] : branches[1].branchId)
    }
    setPairScenario(meta?.scenarioId ?? '')
  }, [list]) // eslint-disable-line react-hooks/exhaustive-deps

  const branchName = (id: string) => { const k = `mri.branch.${id}`; const v = t(k); return v === k ? id : v }
  const pairCard = (branchId: string) => {
    const v = byRun.get(`${meta?.scenarioId}#${branchId}`)
    if (!v) return <div className="faint">…</div>
    const required = v.verdict.checkpoints.filter((c) => c.kind === 'required')
    const passed = required.filter((c) => c.completed).length
    return (
      <div className="traj-pair-card">
        <header>
          <b>{branchName(branchId)}</b>
          <Hint
            className={`traj-pill ${v.verdict.terminalSuccess ? 'term-ok' : 'term-fail'}`}
            text={t('traj.hint.terminal')}
          >
            {v.verdict.terminalSuccess ? t('traj.terminal.ok') : t('traj.terminal.fail')}
          </Hint>
          <CellBadge cell={v.verdict.cell} />
        </header>
        <div className="traj-pair-facts">
          <span><Hint text={t('traj.hint.csr')}>{t('traj.csr.label')}</Hint> {v.verdict.csr === null ? t('traj.unknown') : `${passed}/${required.length}`}</span>
          <span><Hint text={t('traj.hint.div')}>{t('traj.div.short')}</Hint> {v.verdict.firstDivergence === null ? '—' : t('traj.div.value', { step: v.verdict.firstDivergence })}</span>
          <Hint className={v.verdict.hardViolation ? 'traj-hard-yes' : ''} text={t('traj.hint.hard')}>
            {v.verdict.hardViolation ? '✕ ' + t('traj.hard.yes') : '✓ ' + t('traj.hard.no')}
          </Hint>
        </div>
        <StepVerdictStrip steps={v.verdict.steps} />
      </div>
    )
  }

  if (!meta) return null
  const taskKey = `scenario.${meta.scenarioId}.task`
  const taskText = t(taskKey) !== taskKey ? t(taskKey) : f(meta.task)
  return (
    <div className="panel" data-demo="trajboard" style={{ overflowX: 'auto' }}>
      <div className="panel-head">
        <h3>{t('tunnel.traj.title')} <span className="tag">{t('tunnel.traj.tag')}</span></h3>
        <div className="panel-head-actions">
          <span className="faint">{t('tunnel.view.scope')}</span>
          <TunnelViewToggle view={view} onView={onView} />
        </div>
      </div>
      {failed && <div className="faint">{t('traj.unavailable')}</div>}
      {!failed && !list && <div className="faint">{t('common.loading')}</div>}
      {list && (
        <>
          <div className="faint" style={{ marginBottom: 6 }}>{t('tunnel.traj.orderNote')}</div>
          <table className="t tunnel-table" style={{ width: 'max-content' }}>
            <thead>
              <tr>
                <th>{t('tunnel.traj.branch')}</th>
                <th><Hint text={t('traj.hint.terminal')}>{t('traj.terminal')}</Hint></th>
                <th><Hint text={t('traj.hint.process')}>{t('tunnel.traj.process')}</Hint></th>
                <th className="num"><Hint text={t('traj.hint.csr')}>{t('traj.csr.label')}</Hint></th>
                <th className="num"><Hint text={t('traj.hint.div')}>{t('traj.div.label')}</Hint></th>
                <th><Hint text={t('traj.hint.hard')}>{t('traj.hard.label')}</Hint></th>
                <th className="num"><Hint text={t('traj.hint.paths')}>{t('traj.paths.short')}</Hint></th>
                <th>{t('tunnel.readings.colSource')}</th>
              </tr>
            </thead>
            <tbody>
              {branches.map((b) => {
                const v = byRun.get(`${meta.scenarioId}#${b.branchId}`)
                if (!v) return null
                const required = v.verdict.checkpoints.filter((c) => c.kind === 'required')
                const passed = required.filter((c) => c.completed).length
                return (
                  <tr key={b.branchId}>
                    <td><b>{branchName(b.branchId)}</b></td>
                    <td>{v.verdict.terminalSuccess === null ? t('traj.unknown') : v.verdict.terminalSuccess ? t('traj.terminal.ok') : t('traj.terminal.fail')}</td>
                    <td><CellBadge cell={v.verdict.cell} /></td>
                    <td className="num">{v.verdict.csr === null ? t('traj.unknown') : `${passed}/${required.length}`}</td>
                    <td className="num">{v.verdict.firstDivergence === null ? '—' : v.verdict.firstDivergence}</td>
                    <td style={{ color: v.verdict.hardViolation ? 'var(--red)' : undefined }}>{v.verdict.hardViolation ? '✕' : '✓'}</td>
                    <td className="num">{v.contract.pathCount}</td>
                    <td><TrajectorySourceBadge source={v.verdict.source} /></td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {branches.length >= 2 && (
            <>
              <div className="faint" style={{ margin: '12px 0 6px' }}>{t('tunnel.traj.pairTitle')} <span className="tag">{t('tunnel.traj.pairTag')}</span></div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <select value={left} onChange={(e) => setLeft(e.target.value)}>
                  {branches.map((b) => <option key={b.branchId} value={b.branchId}>{branchName(b.branchId)}</option>)}
                </select>
                <span className="faint">vs</span>
                <select value={right} onChange={(e) => setRight(e.target.value)}>
                  {branches.map((b) => <option key={b.branchId} value={b.branchId}>{branchName(b.branchId)}</option>)}
                </select>
              </div>
              <div className="traj-pair">
                {pairCard(left)}
                {pairCard(right)}
              </div>
              <div className="faint" style={{ marginTop: 6 }}>{t('tunnel.traj.pairHint')}</div>
            </>
          )}
          <div className="faint" style={{ marginTop: 8 }}>{taskText}</div>
        </>
      )}
    </div>
  )
}
