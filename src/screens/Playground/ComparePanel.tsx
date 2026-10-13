import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import type { RunDetail, RunSummary } from '../../../shared/playground'
import { TRANSFER_CLEAR, transferModes } from '../../lib/derive'
import { buildCompareTasks, pickDefaultPair } from './compareOrder'
import { FORK_FIELD_LABEL, buildForkDiff, type ForkField, type ForkRow, type StepFields, type TailStep } from './forkDiff'
import { COMPONENT_META, configDiff } from '../../../shared/config'

interface Props {
  runs: RunSummary[]
}

function clip(s: string, n = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n)}…` : flat
}

/** PRD F2-7：同任务双配置逐步轨迹分叉 diff（反事实回放）+ 设计 §14.4 的配置差异 / 干预差异 / 失败转移。 */
export function ComparePanel({ runs }: Props) {
  // Questions that have ≥2 runs, and this question's runs, both in the order
  // compareOrder pins (the run list itself arrives newest-first, which is what
  // used to leave all three dropdowns in a random-looking order).
  const tasks = useMemo(() => buildCompareTasks(runs), [runs])

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
      // The fallback pair comes from arrival order, not from the sorted picker
      // list: reordering the dropdowns must not change what A and B compare.
      const [a, b] = pickDefaultPair(runs, taskId)
      setAId(a)
      setBId(b)
    }
  }, [taskRuns, aId, runs, taskId])

  useEffect(() => {
    for (const id of [aId, bId]) {
      if (id && !details[id]) {
        void api.pgRun(id).then((d) => setDetails((prev) => ({ ...prev, [id]: d })))
      }
    }
  }, [aId, bId, details])

  const A = aId ? details[aId] : null
  const B = bId ? details[bId] : null

  // PRD F2-7：分叉点之前逐行对齐并逐字段比差异，分叉点之后两条路径分开列。
  const fork = useMemo(() => (A && B ? buildForkDiff(A.events, B.events) : null), [A, B])

  // 设计 §14.4：并排看 harness 配置差异。此前这块完全没有。
  const cfgDelta = useMemo(() => {
    if (!A || !B) return []
    return Object.entries(configDiff(A.config, B.config)).map(([field, [av, bv]]) => ({
      field,
      label: COMPONENT_META[field as keyof typeof COMPONENT_META]?.label ?? field,
      a: av,
      b: bv,
    }))
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

      {A && B && (
        <div className="pg-fork-meta">
          <span className="pg-fork-run">
            A <b>{A.configLabel}</b> · {fork?.stepsA ?? 0} steps
          </span>
          <span className="pg-fork-run">
            B <b>{B.configLabel}</b> · {fork?.stepsB ?? 0} steps
          </span>
        </div>
      )}

      {/* 设计 §14.4：并排看 harness 配置差异 */}
      {cfgDelta.length > 0 && (
        <>
          <div className="pg-sub-title">Config difference</div>
          <table className="pg-cfgdiff">
          <thead>
            <tr>
              <th>Field</th>
              <th>A · {A?.configLabel}</th>
              <th>B · {B?.configLabel}</th>
            </tr>
          </thead>
          <tbody>
            {cfgDelta.map((d) => (
              <tr key={d.field}>
                <td className="pg-cfgdiff-field">{d.label}</td>
                <td className="pg-cfgdiff-a">{d.a}</td>
                <td className="pg-cfgdiff-b">{d.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </>
      )}
      {cfgDelta.length === 0 && A && B && <div className="faint" style={{ fontSize: 12 }}>Config difference: none — both runs used the same harness configuration.</div>}

      {fork && (fork.emptyA || fork.emptyB) && (
        <div className="faint" style={{ fontSize: 12 }}>
          {(fork.emptyA ? A?.configLabel : B?.configLabel)} has no recorded trajectory, so there is nothing to
          align. Metrics only.
        </div>
      )}

      {fork && !fork.emptyA && !fork.emptyB && (
        <>
          <div className="pg-compare-summary">
            {fork.noCommonPrefix ? (
              <>The two paths never shared a step — nothing to align. Each path is listed on its own.</>
            ) : fork.forkAt == null ? (
              <>No divergence: both configurations behaved identically across {fork.stepsA} steps.</>
            ) : (
              <>
                Fork point: step {fork.forkAt} — differs on{' '}
                <b>{fork.rows.find((r) => r.fork)?.diff.map((d) => FORK_FIELD_LABEL[d]).join(' / ') ?? '—'}</b>
              </>
            )}
          </div>
          {fork.stepsA !== fork.stepsB && (
            <div className="faint" style={{ fontSize: 12 }}>
              Different path lengths: A ran {fork.stepsA} step{fork.stepsA === 1 ? '' : 's'}, B ran {fork.stepsB}.{' '}
              {fork.forkAt != null && 'Steps after the fork point are listed per path below.'}
            </div>
          )}

          {fork.rows.length > 0 && (
            <div className="pg-align-wrap">
              <table className="pg-align">
                <thead>
                  <tr>
                    <th>Step</th>
                    <th>A · {A?.configLabel}</th>
                    <th>B · {B?.configLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {fork.rows.map((r) => (
                    <tr key={r.n} className={r.fork ? 'fork' : r.diff.length === 0 ? 'same' : 'diverge'}>
                      <td className="pg-align-n">
                        {r.n}
                        {r.fork && <div className="pg-fork-badge">fork</div>}
                      </td>
                      <StepCell fields={r.a} diff={r.diff} side="a" />
                      <StepCell fields={r.b} diff={r.diff} side="b" />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* PRD F2-7：分叉点之后允许逐步对比两条路径如何走向不同终局 */}
          {(fork.tailA.length > 0 || fork.tailB.length > 0) && (
            <>
              <div className="pg-sub-title">After the fork point — the two paths on their own</div>
              <div className="pg-tail-grid">
                <TailColumn label={`A · ${A?.configLabel} · ${fork.stepsA} steps total`} steps={fork.tailA} emptyNote="A ended at the fork point." />
                <TailColumn label={`B · ${B?.configLabel} · ${fork.stepsB} steps total`} steps={fork.tailB} emptyNote="B ended at the fork point." />
              </div>
            </>
          )}
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

/** 一个字段在各侧的取值，差异字段标出来（AC③ 字段级差异）。 */
function fieldLines(fields: StepFields, k: ForkField): string[] {
  if (k === 'thought') return fields.thought ? [clip(fields.thought, 200)] : []
  const list = k === 'tool' ? fields.tools : k === 'observation' ? fields.observations : k === 'decision' ? fields.decisions : fields.tags
  return list.map((s) => clip(s, 200))
}

/**
 * 一侧某一步的字段。差异字段整块高亮并带标签——这是 AC③ 要的「差异高亮到字段级」，
 * 读者一眼看到的是「这一步的工具不同 / 观测不同 / 裁决不同」，而不是两段并排的模型
 * 自述。thought 是差异字段之一，但不是版面主角。
 */
function StepCell({ fields, diff, side }: { fields: StepFields; diff: ForkField[]; side: 'a' | 'b' }) {
  const differs = diff.length > 0
  return (
    <td className={differs ? 'pg-fork-cell differs' : 'pg-fork-cell'}>
      {differs && (
        <div className="pg-fork-legend">differs on: {diff.map((d) => FORK_FIELD_LABEL[d]).join(' / ')}</div>
      )}
      <div className="pg-fork-thought">{fields.thought ? clip(fields.thought, 200) : <span className="pg-fork-none">—</span>}</div>
      {fields.tools.length > 0 && <div className={`pg-fork-line${diff.includes('tool') ? ' hot' : ''}`}>🔧 {clip(fields.tools.join(' · '), 160)}</div>}
      {fields.observations.length > 0 && <div className={`pg-fork-line${diff.includes('observation') ? ' hot' : ''}`}>👁 {clip(fields.observations.join(' · '), 160)}</div>}
      {fields.decisions.length > 0 && <div className={`pg-fork-line${diff.includes('decision') ? ' hot' : ''}`}>⚖ {clip(fields.decisions.join(' · '), 160)}</div>}
      {fields.tags.length > 0 && <div className={`pg-fork-tag${diff.includes('tag') ? ' hot' : ''}`}>⚠ {clip(fields.tags.join(' · '), 120)}</div>}
    </td>
  )
}

/** 分叉点之后的一条路径，按自己的步号逐步行。 */
function TailColumn({ label, steps, emptyNote }: { label: string; steps: TailStep[]; emptyNote: string }) {
  return (
    <div className="pg-tail">
      <div className="pg-tail-head">{label}</div>
      {steps.length === 0 ? (
        <div className="pg-tail-none">{emptyNote}</div>
      ) : (
        steps.map((s) => (
          <div key={s.n} className="pg-tail-step">
            <span className="pg-tail-n">{s.n}</span>
            <div>
              {s.fields.thought && <div className="pg-fork-thought">{clip(s.fields.thought, 160)}</div>}
              {s.fields.tools.length > 0 && <div className="pg-fork-line">🔧 {clip(s.fields.tools.join(' · '), 140)}</div>}
              {s.fields.observations.length > 0 && <div className="pg-fork-line">👁 {clip(s.fields.observations.join(' · '), 140)}</div>}
              {s.fields.decisions.length > 0 && <div className="pg-fork-line">⚖ {clip(s.fields.decisions.join(' · '), 140)}</div>}
              {s.fields.tags.length > 0 && <div className="pg-fork-tag">⚠ {clip(s.fields.tags.join(' · '), 100)}</div>}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
