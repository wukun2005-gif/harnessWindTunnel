// Per-question scorecard: one column per harness config, one row per scoring
// channel plus the numbers the metrics layer actually consumes.
//
// The result matrix above answers "what did each config score"; this answers
// "why", by putting the four readings (deterministic, ROUGE, Jev, LLM) side by
// side for the same question. Comparing two configs off a single `score` is what
// made the C1/G1 false negative look like a harness difference.
//
// Under the readings, the Harness-switch block names which of the 20 switches —
// and which Playground-only mounts — actually differ from the baseline column,
// so a score gap can be traced to a configuration instead of guessed.
import { fingerprint } from '../../../shared/config'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import type { PgPreset, RunDetail, RunSummary } from '../../../shared/playground'
import { allSettled, buildRows } from './resultOrder'
import { pickUiJudgeReading, uiJudgeReadingLine } from './channelText'
import { buildScorecardConfig, diffOnlyGroups, type ScorecardCfgColumn } from './scorecardConfig'

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
  /** The switch block opens on the differences; "show all" is opt-in. */
  const [showAllCfg, setShowAllCfg] = useState(false)

  const toggle = (): void => {
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? '0' : '1')
      } catch { /* ignore */ }
      return !v
    })
  }

  // The newest run per config, in preset order — the same cells the matrix shows.
  // Columns are the configuration identities; the display name comes from the
  // run itself so this card can never invent a name the run list does not use.
  const { map, order, title, taskId } = useMemo(() => {
    const row = buildRows(runs)[0]
    const cells = row?.cells ?? new Map<string, { run: RunSummary; count: number }>()
    const rank = new Map(presets.map((p, i) => [fingerprint(p.config), i]))
    const cols = [...cells.keys()]
      .map((k) => ({
        key: k,
        label: cells.get(k)!.run.configLabel,
        title: cells.get(k)!.run.configTitle,
      }))
      .sort((a, b) => {
        const ra = rank.get(a.key) ?? 99
        const rb = rank.get(b.key) ?? 99
        return ra !== rb ? ra - rb : a.label.localeCompare(b.label)
      })
    return { map: cells, order: cols, title: row?.taskTitle ?? '', taskId: row?.taskId ?? '' }
  }, [runs, presets])

  // ROUGE and the Jev reading live on the run detail, not on the list summary.
  // Keyed by run ids so the list's 1.5s poll does not trigger a refetch — but a run
  // that is still in flight is polled until it settles, because its detail carries no
  // answer/verdict/ROUGE yet and one fetch would freeze that empty snapshot forever.
  const ids = order.map((c) => map.get(c.key)!.run.runId).join(',')
  useEffect(() => {
    if (!ids) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = (): void => {
      const wanted = ids.split(',')
      void Promise.all(wanted.map((id) => api.pgRun(id).catch(() => null))).then((ds) => {
        if (!live) return
        const found = ds.filter((d): d is RunDetail => d != null)
        // Keep details already read: one transient failure must not erase a
        // column's configuration and leave the switch diff stuck on "reading".
        setDetails((prev) => {
          const next = new Map(prev)
          for (const d of found) next.set(d.runId, d)
          return next
        })
        if (found.length < wanted.length || !allSettled(found)) timer = setTimeout(tick, POLL_MS)
      })
    }
    tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [ids])

  // The switch diff needs every column's full detail: a missing detail is
  // "unknown", not "same as the baseline", so the block waits instead of
  // rendering a table of false matches.
  const cfg = useMemo(() => {
    if (order.length < 2) return null
    const columns: ScorecardCfgColumn[] = []
    for (const col of order) {
      const id = map.get(col.key)?.run.runId
      const detail = id ? details.get(id) : null
      if (!detail) return null
      columns.push({ label: col.label, detail })
    }
    return buildScorecardConfig(columns)
  }, [order, map, details])

  if (order.length === 0) return null

  const summaryOf = (key: string): RunSummary | null => map.get(key)?.run ?? null
  const detailOf = (key: string): RunDetail | null => {
    const id = map.get(key)?.run.runId
    return id ? details.get(id) ?? null : null
  }

  const lines: Array<{ label: string; hint?: string; of: (key: string) => string }> = [
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
      // Short label: the long report heading widened the label column until the
      // value columns collapsed to a few characters. The full heading stays in
      // the hover title.
      label: t('playground.live.failureTagsShort'),
      hint: t('playground.report.failureTags'),
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
            {order.map((col) => {
              const s = summaryOf(col.key)!
              const c = map.get(col.key)!.count
              return (
                <span key={col.key} title={col.title ?? undefined} style={{ minWidth: 0, textAlign: 'right', fontSize: 11, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
                  <b style={{ color: 'var(--text)', whiteSpace: 'nowrap' }}>{col.label}</b>
                  <span className="faint" style={{ whiteSpace: 'nowrap' }}>{shortTime(s.createdAt)}</span>
                  {/* The model string is longer than one column; wrapping keeps it
                      inside its own column instead of overlapping the neighbours. */}
                  <span className="faint" style={{ fontFamily: 'var(--mono)', fontSize: 10, textAlign: 'right', overflowWrap: 'anywhere', lineHeight: 1.25 }}>{s.model}</span>
                  {c > 1 && <span className="faint" title={t('playground.live.latestOf', { count: c })}> ×{c}</span>}
                </span>
              )
            })}

            {lines.map((ln) => (
              <Fragment key={ln.label}>
                <span className="faint" title={ln.hint} style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                  {ln.label}
                </span>
                {order.map((col) => (
                  <span key={col.key} style={{ fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right', wordBreak: 'break-word' }}>
                    {ln.of(col.key)}
                  </span>
                ))}
              </Fragment>
            ))}

            {order.length >= 2 && (
              <>
                <div className="pg-scdiff-head" style={{ gridColumn: '1 / -1' }}>
                  <b className="pg-scdiff-title">{t('playground.live.cfgDiff')}</b>
                  {cfg && (
                    <span className="pg-scdiff-ref">
                      {t('playground.live.cfgDiffRef', { ref: cfg.refLabel })}
                    </span>
                  )}
                  {cfg && (
                    <span className="pg-scdiff-count">
                      {t('playground.live.cfgDiffSummary', {
                        diff: cfg.diffCount,
                        same: cfg.totalCount - cfg.diffCount,
                      })}
                    </span>
                  )}
                  {cfg && cfg.diffCount > 0 && (
                    <button className="pg-scdiff-toggle" onClick={() => setShowAllCfg((v) => !v)}>
                      {showAllCfg
                        ? t('playground.live.cfgDiffShowDiff', { diff: cfg.diffCount })
                        : t('playground.live.cfgDiffShowAll', { total: cfg.totalCount })}
                    </button>
                  )}
                </div>

                {cfg ? (
                  <>
                    <div className="pg-scdiff-hint" style={{ gridColumn: '1 / -1' }}>
                      <i className="pg-scdiff-swatch diff" />
                      {t('playground.live.cfgDiffLegendDiff')}
                      <i className="pg-scdiff-swatch" style={{ marginLeft: 10 }} />
                      {t('playground.live.cfgDiffLegendSame')}
                    </div>
                    {(showAllCfg || cfg.diffCount === 0 ? cfg.groups : diffOnlyGroups(cfg)).map((group) => {
                      const full = cfg.groups.find((g) => g.id === group.id)
                      return (
                        <Fragment key={group.id}>
                          <div className="pg-scdiff-group" style={{ gridColumn: '1 / -1' }}>
                            {t(`playground.live.cfgGroup.${group.id}`)}
                            {full && (
                              <span className="pg-scdiff-gcount">
                                {full.rows.filter((r) => r.anyDiff).length}/{full.rows.length}
                              </span>
                            )}
                          </div>
                          {group.rows.map((row) => {
                            const label =
                              row.kind === 'field'
                                ? t(`playground.live.cfg.${row.id}`)
                                : row.kind === 'mount'
                                  ? t('playground.live.cfgRow.mountPatents')
                                  : t('playground.live.cfgRow.customGuide')
                            return (
                              <Fragment key={row.id}>
                                <span className={`pg-scdiff-label${row.anyDiff ? ' changed' : ''}`}>{label}</span>
                                {row.cells.map((cell, i) => (
                                  <span
                                    key={order[i].key}
                                    className={`pg-scdiff-val${i === 0 ? ' ref' : ''}${cell.diff ? ' diff' : ''}${row.kind === 'guide' ? ' guide' : ''}`}
                                    title={
                                      i === 0
                                        ? t('playground.live.cfgCellRef', { label, value: cell.full || DASH })
                                        : cell.diff
                                          ? t('playground.live.cfgCellDiff', {
                                              label,
                                              value: cell.full || DASH,
                                              ref: cfg.refLabel,
                                              refValue: row.cells[0].full || DASH,
                                            })
                                          : t('playground.live.cfgCellSame', { label, value: cell.full || DASH })
                                    }
                                  >
                                    {cell.text || DASH}
                                  </span>
                                ))}
                              </Fragment>
                            )
                          })}
                        </Fragment>
                      )
                    })}
                  </>
                ) : (
                  <span className="pg-scdiff-loading" style={{ gridColumn: '1 / -1' }}>
                    {t('playground.live.cfgDiffLoading')}
                  </span>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}
