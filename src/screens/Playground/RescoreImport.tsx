import { useState } from 'react'
import { api } from '../../api'
import type { EvalTask } from '../../../shared/playground'

interface Props {
  runId: string
  tasks: EvalTask[]
  onRescored: () => void
}

/**
 * Link an imported run to a real eval task and score it locally (design §10 M3).
 * Imported trajectories arrive with success=null and are excluded from every
 * aggregate; this is the gate that brings them in once the user picks the task
 * they represent.
 */
export function RescoreImport({ runId, tasks, onRescored }: Props) {
  const [taskId, setTaskId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function run() {
    if (!taskId) return
    setBusy(true)
    setErr(null)
    try {
      await api.pgRescore(runId, taskId)
      onRescored()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel" style={{ display: 'grid', gap: 6, background: 'var(--bg-panel2)' }}>
      <b style={{ color: 'var(--text)', fontSize: 12 }}>Imported trajectory: link an eval task and re-score</b>
      <span className="faint" style={{ fontSize: 11 }}>
        Imported trajectories stay out of the statistics by default. Pick the eval task it belongs to; once scored locally it joins the success rate and the matrices.
      </span>
      <label className="pg-field">
        <span>Eval task</span>
        <select value={taskId} onChange={(e) => setTaskId(e.target.value)}>
          <option value="">Choose a task…</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>[{t.id}] {t.title}</option>
          ))}
        </select>
      </label>
      <button className="primary" disabled={busy || !taskId} onClick={() => void run()}>
        {busy ? 'Scoring…' : 'Link and re-score'}
      </button>
      {err && <span style={{ color: 'var(--red)', fontSize: 11 }}>{err}</span>}
    </div>
  )
}
