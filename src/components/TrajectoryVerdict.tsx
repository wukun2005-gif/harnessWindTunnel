// F7 reusable trajectory-verdict band (dev-plan D8/D11). Shows terminal and
// process verdicts side by side — neither overwrites the other — plus CSR,
// first divergence (clickable), hard violation and provenance. No composite
// "trajectory score" is ever rendered (ADR-07).
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT, useFixture } from '../i18n'
import { Hint } from './Hint'
import type { StepVerdictKind, TrajectorySource, TrajectoryVerdictResponse } from '../../shared/trajectory'

/** Fetch one verdict; a run without a contract (404) or an offline server stays silent. */
export function useTrajectoryVerdict(runId: string | null | undefined) {
  const [data, setData] = useState<TrajectoryVerdictResponse | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let live = true
    setData(null)
    setFailed(false)
    if (!runId || runId.startsWith('imported#')) { setLoading(false); return }
    setLoading(true)
    api.trajectoryVerdict(runId)
      .then((r) => { if (live) setData(r) })
      .catch(() => { if (live) setFailed(true) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [runId])
  return { data, failed, loading }
}

const CELL_CLS: Record<string, string> = {
  'trusted-success': 'cell-trusted',
  'fluke-success': 'cell-fluke',
  'one-step-short': 'cell-short',
  'clear-failure': 'cell-clear',
}

export function TrajectorySourceBadge({ source }: { source: TrajectorySource }) {
  const t = useT()
  return (
    <Hint className={`src-badge traj-src-${source}`} text={t(`traj.hint.source.${source}`)}>
      {t(`traj.source.${source}`)}
    </Hint>
  )
}

export function CellBadge({ cell, processIncomplete = false }: { cell: string | null; processIncomplete?: boolean }) {
  const t = useT()
  if (processIncomplete) {
    return (
      <Hint className="traj-pill cell-incomplete" text={t('traj.hint.cell.incomplete')}>
        {t('traj.cell.incomplete')}
      </Hint>
    )
  }
  if (!cell) {
    return <Hint className="traj-pill cell-unknown" text={t('traj.hint.cell.unknown')}>{t('traj.cell.unknown')}</Hint>
  }
  return <Hint className={`traj-pill ${CELL_CLS[cell]}`} text={t(`traj.hint.cell.${cell}`)}>{t(`traj.cell.${cell}`)}</Hint>
}

const STEP_CLS: Record<StepVerdictKind, string> = {
  required: 'sv-required',
  recovering: 'sv-recovering',
  redundant: 'sv-redundant',
  violating: 'sv-violating',
  neutral: 'sv-neutral',
}

/** Compact per-step verdict strip (used by the band and the tunnel pair view). */
export function StepVerdictStrip({ steps, onJumpStep }: { steps: Array<{ step: number; verdict: StepVerdictKind; blockedCorrect?: boolean; severity?: string }>; onJumpStep?: (step: number) => void }) {
  const t = useT()
  return (
    <div className="traj-steps">
      {steps.map((s) => (
        <button
          key={s.step}
          className={`traj-step-chip ${STEP_CLS[s.verdict]}${s.severity === 'hard' ? ' hard' : ''}`}
          title={`${t('mri.step.tag', { step: s.step })} · ${t(`traj.stepv.${s.verdict}`)}${s.blockedCorrect ? ` · ${t('traj.blocked')}` : ''}`}
          onClick={onJumpStep ? () => onJumpStep(s.step) : undefined}
          style={onJumpStep ? undefined : { cursor: 'default' }}
        >
          {s.step}{s.blockedCorrect ? '🛡' : ''}
        </button>
      ))}
    </div>
  )
}

/**
 * The judge's own reading, placed beside the trajectory band and never merged
 * into it. Live `run.finished.success` only says the run completed, so without
 * this row a clean process on a wrong answer would read as "trusted success".
 */
export function JudgeRow({ judgeSuccess, judgeScore, cell }: {
  judgeSuccess: boolean | null
  judgeScore: number | null
  cell: string | null
}) {
  const t = useT()
  const disagree = judgeSuccess === false && cell === 'trusted-success'
  return (
    <div className={`panel traj-judge${disagree ? ' disagree' : ''}`}>
      <span className="faint">{t('traj.judge.label')}</span>
      <b className={judgeSuccess === false ? 'traj-hard-yes' : ''}>
        {judgeSuccess === true ? t('traj.judge.pass') : judgeSuccess === false ? t('traj.judge.fail') : t('traj.judge.unknown')}
      </b>
      {judgeScore !== null && <span className="mono faint">{(judgeScore * 100).toFixed(0)}%</span>}
      <span className="faint" style={{ marginLeft: 6 }}>{t('traj.judge.note')}</span>
      {disagree && <div className="traj-note">{t('traj.judge.disagree')}</div>}
    </div>
  )
}

export default function TrajectoryVerdictBand({ data, onJumpStep, showCheckpoints = true }: {
  data: TrajectoryVerdictResponse
  onJumpStep?: (step: number) => void
  showCheckpoints?: boolean
}) {
  const t = useT()
  const f = useFixture()
  const [open, setOpen] = useState(false)
  const v = data.verdict
  const contract = data.contract
  const required = v.checkpoints.filter((c) => c.kind === 'required')
  const passed = required.filter((c) => c.completed).length
  const unknown = required.filter((c) => c.unknown).length
  const blocked = v.steps.filter((s) => s.blockedCorrect).length
  const violatingSteps = v.steps.filter((s) => s.verdict === 'violating')
  const [divCode] = (v.divergenceReason ?? '').split(':')
  const divRef = (v.divergenceReason ?? '').split(':')[1] ?? ''

  return (
    <div className="panel traj-band" data-demo="traj">
      <h3>
        {t('traj.title')} <Hint className="tag" text={t('traj.hint.tag')}>{t('traj.tag')}</Hint>
        <Hint
          className="traj-meta mono"
          text={t('traj.hint.contract', {
            id: contract.contractId,
            version: contract.version,
            paths: contract.pathCount,
            author: contract.author,
            reviewer: contract.reviewer,
          })}
        >
          {contract.contractId} · v{contract.version}
        </Hint>
        <Hint className="faint" style={{ marginLeft: 6 }} text={t('traj.hint.paths')}>
          {t('traj.paths', { n: contract.pathCount })}
        </Hint>
        <span style={{ float: 'right' }}><TrajectorySourceBadge source={v.source} /></span>
      </h3>
      <div className="traj-duo">
        <Hint
          className={`traj-pill ${v.terminalSuccess === true ? 'term-ok' : v.terminalSuccess === false ? 'term-fail' : 'term-unknown'}`}
          text={t('traj.hint.terminal')}
        >
          {t('traj.terminal')} · {v.terminalSuccess === true ? t('traj.terminal.ok') : v.terminalSuccess === false ? t('traj.terminal.fail') : t('traj.terminal.unknown')}
        </Hint>
        <span className="faint">× </span>
        <CellBadge cell={v.cell} processIncomplete={v.processIncomplete} />
        {v.cell === 'fluke-success' && <span className="traj-note">{t('traj.fluke.note')}</span>}
        {v.processIncomplete && <span className="traj-note traj-note-incomplete">{t('traj.incomplete.note')}</span>}
      </div>
      {v.source === 'live' && (
        <div className="traj-live-note">{t('traj.live.note')}</div>
      )}
      <div className="traj-facts">
        <div><Hint text={t('traj.hint.csr')}>{t('traj.csr.label')}</Hint><b>{v.csr === null ? t('traj.unknown') : `${passed}/${required.length - unknown}`}</b></div>
        <div>
          <Hint text={t('traj.hint.div')}>{t('traj.div.label')}</Hint>
          {v.firstDivergence === null
            ? <b>{t('traj.div.none')}</b>
            : <b>
                {t('traj.div.value', { step: v.firstDivergence })}
                {onJumpStep && <button className="chip" style={{ marginLeft: 6 }} onClick={() => onJumpStep(v.firstDivergence as number)}>◆ {t('traj.div.jump', { step: v.firstDivergence })}</button>}
              </b>}
        </div>
        <div><Hint text={t('traj.hint.hard')}>{t('traj.hard.label')}</Hint><b className={v.hardViolation ? 'traj-hard-yes' : ''}>{v.hardViolation ? '✕ ' + t('traj.hard.yes') : '✓ ' + t('traj.hard.no')}</b></div>
        {v.softViolations > 0 && <div><Hint text={t('traj.hint.soft')}>{t('traj.soft.label')}</Hint><b>{t('traj.soft.value', { n: v.softViolations })}</b></div>}
        {blocked > 0 && <div><Hint text={t('traj.hint.blocked')}>{t('traj.blocked.label')}</Hint><b>{t('traj.blocked.value', { n: blocked })}</b></div>}
        {v.metrics.pvr !== null && <div><Hint text={t('traj.hint.pvr')}>PVR</Hint><b>{v.metrics.pvr === 1 ? t('traj.pvr.legal') : t('traj.pvr.illegal')}</b></div>}
        {v.metrics.pe !== null && <div><Hint text={t('traj.hint.pe')}>PE</Hint><b>{(v.metrics.pe * 100).toFixed(0)}%</b></div>}
      </div>
      {v.firstDivergence !== null && v.divergenceReason && (
        <div className="traj-div-reason">
          {t('traj.reason.intro')} {t(`traj.reason.${divCode || 'neutral'}`)}
          {divRef && <span className="faint mono"> ({divRef})</span>}
        </div>
      )}
      {violatingSteps.length > 0 && (
        <div className="traj-violations">
          {violatingSteps.map((s) => {
            const rule = contract.forbidden.find((x) => x.id === s.ruleId)
            return (
              <span key={s.step} className={`traj-violation ${s.severity === 'hard' ? 'hard' : 'soft'}`}>
                {t('mri.step.tag', { step: s.step })} · {rule ? f(rule.label) : s.ruleId}
              </span>
            )
          })}
        </div>
      )}
      <StepVerdictStrip steps={v.steps} onJumpStep={onJumpStep} />
      {showCheckpoints && (
        <>
          <button className="chip" style={{ marginTop: 8 }} onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} {t('traj.checkpoints.title')} ({v.checkpoints.length})
          </button>
          {open && (
            <div className="traj-cp-list">
              {v.checkpoints.map((c) => (
                <div key={c.id} className={`traj-cp-row ${c.completed ? 'pass' : c.unknown ? 'unknown' : 'miss'}`}>
                  <span className="traj-cp-kind">{t(c.kind === 'required' ? 'traj.cp.required' : 'traj.cp.optional')}</span>
                  <span className="traj-cp-desc" title={c.id}>{f(contract.checkpoints.find((x) => x.id === c.id)?.description ?? c.id)}</span>
                  <span className="traj-cp-state">
                    {c.unknown
                      ? t(c.applies === false ? 'traj.cp.notApplicable' : 'traj.cp.unknown')
                      : c.completed
                        ? t('traj.cp.pass', { step: c.completedAtStep ?? '—' })
                        : c.windowClosedAtStep !== null && c.windowClosedAtStep !== undefined
                          ? t('traj.cp.window', { step: c.windowClosedAtStep, label: f(c.windowLabel ?? '') })
                          : t('traj.cp.miss')}
                  </span>
                  <span className="traj-cp-ev mono">{c.evidenceEventId ?? ''}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="faint" style={{ marginTop: 6 }}>{t('traj.footnote')}</div>
    </div>
  )
}
