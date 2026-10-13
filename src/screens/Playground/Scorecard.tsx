// Per-question scorecard: one column per harness config, one row per scoring
// channel plus the numbers the metrics layer actually consumes.
//
// The result matrix above answers "what did each config score"; this answers
// "why", by putting the four readings (deterministic, ROUGE, Jev, LLM) side by
// side for the same question. Comparing two configs off a single `score` is what
// made the C1/G1 false negative look like a harness difference.
import { Fragment, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import type { PgPreset, RunDetail, RunSummary } from '../../../shared/playground'
import { allSettled, buildRows } from './resultOrder'
import { pickUiJudgeReading, uiJudgeReadingLine } from './channelText'

/** Same cadence as the run list, so the two never disagree about what is in flight. */
const POLL_MS = 1500

/** Local wall-clock, minute precision — matches the run detail header. */
function shortTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const DASH = '—'

/** Collapsed state survives a reload; the panel sits between two things people read. */
const OPEN_KEY = 'hwt-playground-scorecard'

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

export function Scorecard({ runs, presets }: { runs: RunSummary[]; presets: PgPreset[] }) {
  const t = useT()
  const [details, setDetails] = useState<Map<string, RunDetail>>(new Map())
  const [open, setOpen] = useState(loadOpen)

  const toggle = (): void => {
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? '0' : '1')
      } catch { /* ignore */ }
      return !v
    })
  }

  // The newest run per config, in preset order — the same cells the matrix shows.
  const { map, order, title, taskId } = useMemo(() => {
    const row = buildRows(runs)[0]
    const cells = row?.cells ?? new Map<string, { run: RunSummary; count: number }>()
    const cols: string[] = presets.map((p) => p.id).filter((id) => cells.has(id))
    if (cells.has('custom')) cols.push('custom')
    return { map: cells, order: cols, title: row?.taskTitle ?? '', taskId: row?.taskId ?? '' }
  }, [runs, presets])

  // ROUGE and the Jev reading live on the run detail, not on the list summary.
  // Keyed by run ids so the list's 1.5s poll does not trigger a refetch — but a run
  // that is still in flight is polled until it settles, because its detail carries no
  // answer/verdict/ROUGE yet and one fetch would freeze that empty snapshot forever.
  const ids = order.map((k) => map.get(k)!.run.runId).join(',')
  useEffect(() => {
    if (!ids) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      void Promise.all(ids.split(',').map((id) => api.pgRun(id).catch(() => null))).then((ds) => {
        if (!live) return
        const found = ds.filter((d): d is RunDetail => d != null)
        setDetails(new Map(found.map((d) => [d.runId, d])))
        if (!allSettled(found)) timer = setTimeout(tick, POLL_MS)
      })
    }
    tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [ids])

  if (order.length === 0) return null

  const summaryOf = (key: string): RunSummary | null => map.get(key)?.run ?? null
  const detailOf = (key: string): RunDetail | null => {
    const id = map.get(key)?.run.runId
    return id ? details.get(id) ?? null : null
  }

  const lines: Array<{ label: string; of: (key: string) => string }> = [
    {
      label: t('playground.live.judgeVerdict'),
      of: (k) => {
        const s = summaryOf(k)
        if (!s || s.score == null) return t('playground.live.notScoredShort')
        return `${s.success ? '✓' : '✗'} ${s.score.toFixed(2)}`
      },
    },
    {
      label: t('playground.live.cmpJev'),
      of: (k) => {
        // 与详情页同一口径：只呈现判定模型（mercury）的读数，旧判分器读数不显示。
        const picked = pickUiJudgeReading(detailOf(k)?.jevResult)
        return picked ? uiJudgeReadingLine(picked) : DASH
      },
    },
    {
      label: t('playground.report.failureTags'),
      of: (k) => summaryOf(k)?.failureTags.join(' ') || DASH,
    },
    {
      label: t('playground.live.tokens'),
      of: (k) => {
        const n = summaryOf(k)?.tokens
        return n == null ? DASH : String(n)
      },
    },
    {
      label: t('playground.live.latency'),
      of: (k) => {
        const ms = summaryOf(k)?.latencyMs
        return ms == null ? DASH : `${(ms / 1000).toFixed(1)}s`
      },
    },
    {
      label: t('playground.live.answerChars'),
      of: (k) => {
        const a = detailOf(k)?.answer
        return a == null ? DASH : String(a.length)
      },
    },
  ]

  return (
    <div className="panel" style={{ display: 'grid', gap: open ? 8 : 0 }}>
      <button
        onClick={toggle}
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'baseline',
          flexWrap: 'wrap',
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
        <b style={{ color: 'var(--text)', fontSize: 12 }}>{t('playground.live.scorecard')}</b>
        <code style={{ fontSize: 11 }}>{taskId}</code>
        <span className="faint" style={{ fontSize: 12 }}>{title}</span>
      </button>

      {open && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `max-content repeat(${order.length}, minmax(0, 1fr))`,
              columnGap: 12,
              rowGap: 4,
              fontSize: 12,
              overflowX: 'auto',
            }}
          >
            <span />
            {order.map((k) => {
              const s = summaryOf(k)!
              const c = map.get(k)!.count
              return (
                <span key={k} style={{ textAlign: 'right', fontSize: 11, whiteSpace: 'nowrap', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                  <b style={{ color: 'var(--text)' }}>{k}</b>
                  <span className="faint">{shortTime(s.createdAt)}</span>
                  <span className="faint" style={{ fontFamily: 'var(--mono)', fontSize: 10 }}>{s.model}</span>
                  {c > 1 && <span className="faint" title={t('playground.live.latestOf', { count: c })}> ×{c}</span>}
                </span>
              )
            })}

            {lines.map((ln) => (
              <Fragment key={ln.label}>
                <span className="faint" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                  {ln.label}
                </span>
                {order.map((k) => (
                  <span key={k} style={{ fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right', wordBreak: 'break-word' }}>
                    {ln.of(k)}
                  </span>
                ))}
              </Fragment>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
