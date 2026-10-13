import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import type { RunDetail, RunSummary } from '../../../shared/playground'
import { TRANSFER_CLEAR, deriveRun, transferModes } from '../../lib/derive'

interface Props {
  runs: RunSummary[]
}

function shortTool(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 90)
}

/**
 * Trajectory fork comparison (design §10 M3): pick two runs of the same task
 * (typically two harness configs), get a step-aligned diff and a per-step
 * failure-mode transfer matrix. Computed entirely from recorded events with
 * the same deterministic align/transfer routines used elsewhere.
 */
export function ComparePanel({ runs }: Props) {
  // Tasks that have ≥2 runs.
  const tasks = useMemo(() => {
    const map = new Map<string, { title: string; runs: RunSummary[] }>()
    for (const r of runs) {
      const e = map.get(r.taskId) ?? { title: r.taskTitle, runs: [] }
      e.runs.push(r)
      map.set(r.taskId, e)
    }
    return [...map.entries()].filter(([, v]) => v.runs.length >= 2).map(([id, v]) => ({ id, ...v }))
  }, [runs])

  const [taskId, setTaskId] = useState('')
  const [aId, setAId] = useState('')
  const [bId, setBId] = useState('')
  const [details, setDetails] = useState<Record<string, RunDetail>>({})

  useEffect(() => {
    if (!taskId && tasks[0]) setTaskId(tasks[0].id)
  }, [tasks, taskId])

  const taskRuns = tasks.find((t) => t.id === taskId)?.runs ?? []
  useEffect(() => {
    if (taskRuns.length >= 2 && (!aId || !taskRuns.some((r) => r.runId === aId))) {
      setAId(taskRuns[0]!.runId)
      setBId(taskRuns[1]!.runId)
    }
  }, [taskRuns, aId])

  useEffect(() => {
    for (const id of [aId, bId]) {
      if (id && !details[id]) {
        void api.pgRun(id).then((d) => setDetails((prev) => ({ ...prev, [id]: d })))
      }
    }
  }, [aId, bId, details])

  const A = aId ? details[aId] : null
  const B = bId ? details[bId] : null

  const aligned = useMemo(() => {
    if (!A || !B) return null
    const da = deriveRun(A.events)
    const db = deriveRun(B.events)
    const rows: { n: number; same: boolean; aThought: string; aTools: string; bThought: string; bTools: string; aTag?: string; bTag?: string }[] = []
    const n = Math.max(da.steps.length, db.steps.length)
    for (let i = 0; i < n; i++) {
      const sa = da.steps[i] ?? null
      const sb = db.steps[i] ?? null
      const same =
        !!sa &&
        !!sb &&
        sa.thought === sb.thought &&
        JSON.stringify(sa.tools.map((t) => t.tool)) === JSON.stringify(sb.tools.map((t) => t.tool))
      rows.push({
        n: i + 1,
        same,
        aThought: sa?.thought ? shortTool(sa.thought) : '(no such step)',
        aTools: sa?.tools.map((t) => t.tool).join(', ') ?? '',
        bThought: sb?.thought ? shortTool(sb.thought) : '(no such step)',
        bTools: sb?.tools.map((t) => t.tool).join(', ') ?? '',
        aTag: sa?.tags.map((t) => t.detail).join('; '),
        bTag: sb?.tags.map((t) => t.detail).join('; '),
      })
    }
    return { rows, firstDiverge: rows.findIndex((r) => !r.same) + 1 }
  }, [A, B])

  const transfer = useMemo(() => {
    if (!A || !B) return null
    return transferModes(A.events, B.events)
  }, [A, B])

  if (tasks.length === 0) {
    return <div className="pg-empty">Divergence comparison needs at least two runs of the same task.</div>
  }

  return (
    <div className="pg-compare">
      <div className="pg-compare-picks">
        <label className="pg-field">
          <span>Task</span>
          <select value={taskId} onChange={(e) => { setTaskId(e.target.value); setAId(''); setBId('') }}>
            {tasks.map((t) => (
              <option key={t.id} value={t.id}>[{t.id}] {t.title}</option>
            ))}
          </select>
        </label>
        <label className="pg-field">
          <span>Config A</span>
          <select value={aId} onChange={(e) => setAId(e.target.value)}>
            {taskRuns.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.configLabel} · {r.source}
              </option>
            ))}
          </select>
        </label>
        <label className="pg-field">
          <span>Config B</span>
          <select value={bId} onChange={(e) => setBId(e.target.value)}>
            {taskRuns.map((r) => (
              <option key={r.runId} value={r.runId}>
                {r.configLabel} · {r.source}
              </option>
            ))}
          </select>
        </label>
      </div>

      {aligned && (
        <>
          <div className="pg-compare-summary">
            First divergence: step {aligned.firstDiverge}
          </div>
          <div className="pg-align-wrap">
            <table className="pg-align">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>A thought / tools</th>
                  <th>B thought / tools</th>
                </tr>
              </thead>
              <tbody>
                {aligned.rows.map((r) => (
                  <tr key={r.n} className={r.same ? 'same' : 'diverge'}>
                    <td className="pg-align-n">{r.n}</td>
                    <td>
                      <div className="pg-align-thought">{r.aThought}</div>
                      {r.aTools && <div className="pg-align-tools">🔧 {r.aTools}</div>}
                      {r.aTag && <div className="pg-align-tag">{r.aTag}</div>}
                    </td>
                    <td>
                      <div className="pg-align-thought">{r.bThought}</div>
                      {r.bTools && <div className="pg-align-tools">🔧 {r.bTools}</div>}
                      {r.bTag && <div className="pg-align-tag">{r.bTag}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {transfer && transfer.steps > 0 && (
        <>
          <div className="pg-sub-title">Failure-mode transfer (step-aligned)</div>
          <div className="pg-hmap-wrap">
            <table className="pg-hmap">
              <thead>
                <tr>
                  <th className="pg-hmap-rowhead">From \\ To</th>
                  {transfer.modes.map((m) => (
                    <th key={m}>{m === TRANSFER_CLEAR ? 'clear' : m}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.keys(transfer.rows).map((from) => (
                  <tr key={from}>
                    <td className="pg-hmap-rowhead">{from === TRANSFER_CLEAR ? 'clear' : from}</td>
                    {transfer.modes.map((m) => {
                      const v = transfer.rows[from]?.[m] ?? 0
                      return (
                        <td key={m}>
                          <div
                            className="pg-hmap-cell"
                            style={{ background: v ? `rgba(2,132,199,${Math.min(0.7, 0.14 + v * 0.18).toFixed(2)})` : 'transparent' }}
                          >
                            {v || ''}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
