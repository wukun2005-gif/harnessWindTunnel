// P2 step 8 — model-generated failure tags for one recorded run.
//
// The block is deliberately plain and carries three warnings: the tags are
// model output, they are not a gold annotation, and they cannot move the hard
// violation. The trajectory verdict above it is the only thing that can.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { useT } from '../i18n'
import { Hint } from './Hint'
import type { TrajectoryTagRecord } from '../../shared/trajectory'
import { MAST_LABEL } from '../../shared/mast'

function when(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString()
}

export default function TrajectoryTags({ runId }: { runId: string }) {
  const t = useT()
  const [record, setRecord] = useState<TrajectoryTagRecord | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    setRecord(null)
    setError(null)
    api.trajectoryTags(runId)
      .then((r) => { if (live) setRecord(r.tags) })
      .catch(() => { /* no tags yet is not an error */ })
    return () => { live = false }
  }, [runId])

  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.requestTrajectoryTags(runId)
      if (r.ok && r.tags) setRecord(r.tags)
      else setError(r.error ?? 'unknown')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="panel traj-tags" data-demo="traj-tags">
      <h3>
        {t('traj.tags.title')} <Hint className="tag" text={t('traj.tags.note')}>{t('traj.tags.tag')}</Hint>
        <button className="chip" style={{ float: 'right' }} onClick={() => void run()} disabled={busy}>
          {busy ? t('traj.tags.working') : record ? t('traj.tags.regenerate') : t('traj.tags.generate')}
        </button>
      </h3>
      <p className="faint" style={{ margin: '2px 0 6px', fontSize: 11 }}>{t('traj.tags.note')}</p>
      {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{t('traj.tags.failed', { error })}</div>}
      {!error && !record && !busy && (
        <div className="faint" style={{ fontSize: 12 }}>—</div>
      )}
      {record && (
        <>
          {record.tags.length === 0 ? (
            <div className="faint" style={{ fontSize: 12 }}>{t('traj.tags.empty')}</div>
          ) : (
            <div className="traj-tag-list">
              {record.tags.map((tag, i) => (
                <div key={`${tag.tag}-${i}`} className="traj-tag-row">
                  <span className="traj-tag-name">{MAST_LABEL[tag.tag]}</span>
                  <span className="faint">{t('traj.tags.confidence', { n: tag.confidence.toFixed(2) })}</span>
                  {tag.step !== null && <span className="faint">· {t('traj.tags.step', { step: tag.step })}</span>}
                  <span className="traj-tag-why">{tag.why}</span>
                </div>
              ))}
            </div>
          )}
          {record.summary && (
            <p className="faint" style={{ fontSize: 12, marginTop: 6 }}>
              <b>{t('traj.tags.summary')}：</b>{record.summary}
            </p>
          )}
          <div className="faint mono" style={{ fontSize: 10, marginTop: 4 }}>
            {t('traj.tags.by', { model: record.model, at: when(record.generatedAt), version: record.contractVersion })}
          </div>
        </>
      )}
    </div>
  )
}
