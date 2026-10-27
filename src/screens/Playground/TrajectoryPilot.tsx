// The trajectory tab — the two readings the plan asks for after the per-run band:
//
//   1. Same-question consistency: a recorded reference sample vs every later run
//      of the same question. A disagreement is surfaced, never auto-corrected; the
//      suspect list names checkpoints that never fired, which is the first thing
//      to check before blaming the run.
//   2. Live-only stability: pass^k and dominant-path share per configuration.
//      Fixture replay consistency is not comparable and is not shown here.
//
// Both readings come from the same evaluator and the same contract version as
// the run-detail band, so a number can never disagree with itself across screens.
import { useEffect, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import { Hint } from '../../components/Hint'
import type { ConsistencyReport, PilotTaskSummary, ReadingBucket, StabilityReport } from '../../../shared/trajectoryStats'

const familyOrder = (id: string): number => (id.startsWith('G') ? 0 : id.startsWith('L') ? 1 : id.startsWith('S') ? 2 : 3)
const taskNumber = (id: string): number => Number(id.replace(/\D/g, '')) || 0

function pct(n: number | null): string {
  return n === null ? '—' : `${Math.round(n * 100)}%`
}

/** Reading buckets and diff fields are internal tokens; only the label is shown. */
const bucketKey = (bucket: ReadingBucket): string =>
  `traj.cell.${bucket === 'process-incomplete' ? 'incomplete' : bucket}`
/** Same wording as the run-detail band, so a label never means two things. */
const bucketHintKey = (bucket: ReadingBucket): string =>
  `traj.hint.cell.${bucket === 'process-incomplete' ? 'incomplete' : bucket}`
const diffKey = (field: string): string =>
  `traj.pilot.diffField.${field === 'cell' ? 'cell' : field === 'hardViolation' ? 'hard' : field === 'firstDivergence' ? 'divergence' : 'path'}`

export default function TrajectoryPilot() {
  const t = useT()
  const [tasks, setTasks] = useState<PilotTaskSummary[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ consistency: ConsistencyReport; stability: StabilityReport } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // The table is dense by design; every token that can be misread carries its own
  // explanation in place, so nobody has to leave the screen to decode a row.
  const walkHint = (r: { matchedPath: string | null; pathSignature: string }): string =>
    r.matchedPath ? t('traj.pilot.pathMatched', { path: r.matchedPath }) : t('traj.pilot.pathNone', { walk: r.pathSignature })
  const csrHint = (n: number | null): string =>
    n === null ? t('traj.pilot.csrNone') : t('traj.pilot.csrValue', { pct: pct(n) })

  useEffect(() => {
    let live = true
    api.trajectoryPilot()
      .then((r) => {
        if (live) {
          setTasks([...r.tasks].sort(
            (a, b) => familyOrder(a.taskId) - familyOrder(b.taskId) || taskNumber(a.taskId) - taskNumber(b.taskId),
          ))
        }
      })
      .catch((e: unknown) => { if (live) { setTasks([]); setErr(e instanceof Error ? e.message : String(e)) } })
    return () => { live = false }
  }, [])

  const inspect = async (taskId: string): Promise<void> => {
    if (open === taskId) { setOpen(null); setDetail(null); return }
    setOpen(taskId)
    setDetail(null)
    try {
      setDetail(await api.trajectoryPilotTask(taskId))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  if (!tasks) return <div className="panel loading">{t('playground.loading')}</div>

  return (
    <div className="panel traj-pilot" data-demo="traj-pilot">
      <h3>
        {t('traj.pilot.title')} <Hint className="tag" text={t('traj.pilot.hint')}>{t('traj.pilot.tag')}</Hint>
      </h3>
      <p className="faint" style={{ fontSize: 11, margin: '2px 0 8px' }}>{t('traj.pilot.hint')}</p>
      {err && <div style={{ color: 'var(--red)', fontSize: 12 }}>{err}</div>}
      {tasks.length === 0 && !err && <div className="faint">{t('traj.pilot.empty')}</div>}

      {tasks.length > 0 && (
        <div className="traj-pilot-scroll">
        <table className="traj-pilot-table">
          <thead>
            <tr>
              <th>{t('traj.pilot.task')}</th>
              <th>{t('traj.pilot.runs')}</th>
              <th>{t('traj.pilot.consistency')}</th>
              <th><Hint text={t('traj.pilot.passKHint')}>{t('traj.pilot.stability')}</Hint></th>
              <th>{t('traj.pilot.dominant')}</th>
              <th>{t('traj.pilot.suspects')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.map((row) => (
              <tr key={row.taskId} className={open === row.taskId ? 'open' : ''}>
                <td><code>{row.taskId}</code></td>
                <td>{row.runs}</td>
                <td>
                  <span className={`traj-pilot-pill v-${row.consistency.verdict}`}>
                    {t(`traj.pilot.verdict.${row.consistency.verdict}`)}
                  </span>
                  {row.consistency.verdict !== 'insufficient' && (
                    <Hint
                      className="faint"
                      style={{ marginLeft: 6 }}
                      text={t('traj.pilot.agreeHint', {
                        agree: row.consistency.agree,
                        compared: row.consistency.compared,
                        // The reference sample is one of the runs but not one of the rows.
                        excluded: Math.max(0, row.runs - 1 - row.consistency.compared),
                      })}
                    >
                      {t('traj.pilot.agree', { agree: row.consistency.agree, compared: row.consistency.compared })}
                    </Hint>
                  )}
                </td>
                <td>
                  <b>{pct(row.stability.pooledPassK)}</b>
                  <span className="faint" style={{ marginLeft: 4 }}>k≤3</span>
                </td>
                <td>
                  <span className="mono" title={row.stability.dominantPath}>{pct(row.stability.dominantShare)}</span>
                </td>
                <td>
                  {row.consistency.suspects.length === 0
                    ? <span className="faint">—</span>
                    : <span className="traj-hard-yes">{row.consistency.suspects.length}</span>}
                </td>
                <td>
                  <button className="chip" onClick={() => void inspect(row.taskId)}>
                    {open === row.taskId ? t('traj.pilot.close') : t('traj.pilot.open')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}

      {open && detail && (
        <div className="traj-pilot-detail">
          <h4>
            {t('traj.pilot.consistency')}
            <span className="faint mono" style={{ marginLeft: 8 }}>
              {detail.consistency.contractId} · v{detail.consistency.contractVersion}
            </span>
          </h4>
          {detail.consistency.rows.length === 0 ? (
            <p className="faint">{t('traj.pilot.insufficient')}</p>
          ) : (
            <div className="traj-pilot-scroll">
            <table className="traj-pilot-table compact traj-runs">
              <thead>
                <tr>
                  <th>{t('traj.pilot.run')}</th>
                  <th><Hint text={t('traj.pilot.bucketHint')}>{t('traj.pilot.bucket')}</Hint></th>
                  <th><Hint text={t('traj.pilot.hardHint')}>{t('traj.pilot.hard')}</Hint></th>
                  <th><Hint text={t('traj.pilot.pathHint')}>{t('traj.pilot.path')}</Hint></th>
                  <th><Hint text={t('traj.pilot.csrHint')}>CSR</Hint></th>
                  <th><Hint text={t('traj.pilot.diffHint')}>{t('traj.pilot.diffHeader')}</Hint></th>
                </tr>
              </thead>
              <tbody>
                {detail.consistency.reference && (
                  <tr className="reference">
                    <td>
                      <code>{detail.consistency.reference.runId}</code>
                      <span className="faint" style={{ marginLeft: 6 }}>{t('traj.pilot.reference')}</span>
                    </td>
                    <td title={t(bucketHintKey(detail.consistency.reference.bucket))}>
                      {t(bucketKey(detail.consistency.reference.bucket))}
                    </td>
                    <td title={detail.consistency.reference.hardViolation ? t('traj.pilot.hardYes') : t('traj.pilot.hardNo')}>
                      {detail.consistency.reference.hardViolation ? '✕' : '✓'}
                    </td>
                    <td className="mono" title={walkHint(detail.consistency.reference)}>
                      {detail.consistency.reference.matchedPath ?? '—'}
                    </td>
                    <td title={csrHint(detail.consistency.reference.csr)}>{pct(detail.consistency.reference.csr)}</td>
                    <td />
                  </tr>
                )}
                {detail.consistency.rows.map((r) => (
                  <tr key={r.reading.runId} className={r.agreesCell === false || r.agreesHard === false ? 'disagree' : ''}>
                    <td><code>{r.reading.runId}</code></td>
                    <td title={t(bucketHintKey(r.reading.bucket))}>{t(bucketKey(r.reading.bucket))}</td>
                    <td title={r.reading.hardViolation ? t('traj.pilot.hardYes') : t('traj.pilot.hardNo')}>
                      {r.reading.hardViolation ? '✕' : '✓'}
                    </td>
                    <td className="mono" title={walkHint(r.reading)}>{r.reading.matchedPath ?? '—'}</td>
                    <td title={csrHint(r.reading.csr)}>{pct(r.reading.csr)}</td>
                    <td className="faint" title={r.agreesCell === null ? t('traj.pilot.notComparableHint') : t('traj.pilot.diffHint')}>
                      {r.agreesCell === null
                        ? t('traj.pilot.notComparable')
                        : r.diffs.length > 0
                          ? t('traj.pilot.diff', { fields: r.diffs.map((d) => t(diffKey(d))).join(' · ') })
                          : '✓'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {detail.consistency.rows.length > 0 && detail.consistency.compared === 0 && (
            <p className="faint" style={{ fontSize: 11 }}>{t('traj.pilot.notComparable')}</p>
          )}
          {detail.consistency.suspects.length > 0 && (
            <ul className="traj-pilot-suspects">
              {detail.consistency.suspects.map((s) => (
                <li key={s.id}>
                  {t('traj.pilot.suspect', { id: s.id, missing: s.missing, runs: s.runs })}
                </li>
              ))}
            </ul>
          )}
          {detail.consistency.suspects.length === 0 && detail.consistency.rows.length > 0 && (
            <p className="faint" style={{ fontSize: 11 }}>{t('traj.pilot.noSuspects')}</p>
          )}

          <h4 style={{ marginTop: 14 }}>{t('traj.pilot.stability')}</h4>
          <p className="faint" style={{ fontSize: 11 }}>{t('traj.pilot.stabilityNote')}</p>
          {detail.stability.groups.length === 0 ? (
            <p className="faint">{t('traj.pilot.insufficient')}</p>
          ) : (
            <div className="traj-pilot-scroll">
            <table className="traj-pilot-table compact">
              <thead>
                <tr>
                  <th>{t('traj.pilot.group')}</th>
                  <th>{t('traj.pilot.runs')}</th>
                  <th><Hint text={t('traj.pilot.passKHint')}>{t('traj.pilot.passK')}</Hint></th>
                  <th>{t('traj.pilot.dominant')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {detail.stability.groups.map((g) => (
                  <tr key={g.fingerprint}>
                    <td><code>{g.configLabel}</code></td>
                    <td>{t('traj.pilot.groupRuns', { n: g.runs, trusted: g.trusted })}</td>
                    <td><b>{pct(g.passK)}</b> <span className="faint">k={g.k}</span></td>
                    <td>
                      <span className="mono" title={g.dominantPath}>{pct(g.dominantShare)}</span>
                    </td>
                    <td className={g.allPass ? 'faint' : 'traj-hard-yes'}>
                      {g.allPass ? t('traj.pilot.allPass') : t('traj.pilot.someFail')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
          {detail.consistency.rows.length > 0 && (
            <Hint
              className="faint"
              style={{ display: 'inline-block', fontSize: 11, marginTop: 6 }}
              text={t('traj.pilot.judgeMismatchHint')}
            >
              {t('traj.pilot.judgeMismatch', {
                n: [detail.consistency.reference, ...detail.consistency.rows.map((r) => r.reading)]
                  .filter((r) => r !== null && r.terminalSuccess === true && r.judgeSuccess === false).length,
              })}
            </Hint>
          )}
        </div>
      )}
    </div>
  )
}
