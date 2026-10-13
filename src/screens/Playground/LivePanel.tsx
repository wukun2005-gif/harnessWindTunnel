// M2 最小跑批入口：选配置与题目 → 真跑 → 看进度、轨迹与攻击链。
//
// 三条诚实铁律（设计 §10 M2 / §15.4 P1#11）：
//   1. 轨迹不可用（空 / 损坏 / 读失败）必须显示明确空状态，绝不沿用上一条 run 的轨迹；
//   2. 列表区分「有轨迹」与「仅指标」，不把仅指标当完整轨迹渲染；
//   3. 成功与否取 L2 判分结果（verdict.success），不取 run.finished 的 success 字段。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import { KILL_CHAIN, KILL_CHAIN_LABEL, type KillChainStage } from '../../../shared/redteam'
import { JEV_POINT_STATE_LABEL } from '../../../shared/jev'
import type { HarnessEvent } from '../../../shared/events'
import type {
  EvalTask,
  LiveMetrics,
  PgDomain,
  PgPreset,
  RunDetail,
  RunSummary,
  RunTargets,
  RunsQuery,
} from '../../../shared/playground'
import { fingerprint } from '../../../shared/config'
import { buildRows, pickActiveRun, type ResultRow } from './resultOrder'
import { ScoreReport } from './ScoreReport'
import { Scorecard } from './Scorecard'
import { isUiJudgeModel, pickUiJudgeReading, uiJudgeReadingLine } from './channelText'
import { moduleActivity, eventAttributions, type ModuleActivity } from './harnessModules'
import { ImportBar } from './ImportBar'
import { SearchBar } from './SearchBar'
import { BulkToolbar } from './BulkToolbar'
import { MetricsPanel } from './MetricsPanel'
import { ComparePanel } from './ComparePanel'
import { RescoreImport } from './RescoreImport'

const DOMAINS: PgDomain[] = ['general', 'legal', 'security']
const POLL_MS = 1500

// Screen state that must survive a tab switch or a reload: which questions were
// ticked, which harness config is selected, and which config the list is filtered
// to. All three used to reset silently, so the batch had to be rebuilt by hand.
const PICKED_KEY = 'hwt-playground-picked'
const PRESET_KEY = 'hwt-playground-preset'
const FILTER_KEY = 'hwt-playground-filter'
/** Collapsed/expanded state of the three M3 review sections, persisted. */
const SECTIONS_KEY = 'hwt-playground-sections'

function loadFilters(): RunsQuery {
  // Back-compat: FILTER_KEY used to hold a bare preset id string.
  try {
    const raw = localStorage.getItem(FILTER_KEY)
    if (raw != null) {
      if (raw.trim().startsWith('{')) {
        const parsed = JSON.parse(raw) as RunsQuery
        return { limit: 1000, ...parsed }
      }
      return { limit: 1000, presetId: (raw.trim() || undefined) as RunsQuery['presetId'] }
    }
  } catch { /* fall through */ }
  return { limit: 1000 }
}

function loadSections(): { search: boolean; metrics: boolean; compare: boolean } {
  try {
    const raw = localStorage.getItem(SECTIONS_KEY)
    if (raw) return { search: false, metrics: false, compare: false, ...(JSON.parse(raw) as object) }
  } catch { /* defaults */ }
  return { search: false, metrics: false, compare: false }
}

function loadPicked(): string[] {
  try {
    const raw = localStorage.getItem(PICKED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function loadString(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback
  } catch {
    return fallback
  }
}

function saveString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch { /* ignore */ }
}

/** Local wall-clock, minute precision — enough to tell a fresh run from last week's. */
function runTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Targets and presets are module-level singletons, fetched at most once per
 * page session. They change only when the Settings screen is edited, so the
 * live tab can be mounted and unmounted freely without refetching — switching
 * to this tab used to hit two endpoints on every switch and felt sluggish.
 * `invalidateTargets()` is what the Settings screen would call after a save.
 */
let targetsCache: RunTargets | null = null
let presetsCache: PgPreset[] | null = null
let targetsPending: Promise<RunTargets> | null = null
let presetsPending: Promise<PgPreset[]> | null = null

function loadTargets(): Promise<RunTargets> {
  if (targetsCache) return Promise.resolve(targetsCache)
  targetsPending ??= api
    .pgTargets()
    .then((r) => {
      targetsCache = r
      return r
    })
    .finally(() => {
      targetsPending = null
    })
  return targetsPending
}

function loadPresets(): Promise<PgPreset[]> {
  if (presetsCache) return Promise.resolve(presetsCache)
  presetsPending ??= api
    .pgPresets()
    .then((r) => {
      presetsCache = r.presets
      return r.presets
    })
    .catch(() => [] as PgPreset[])
    .finally(() => {
      presetsPending = null
    })
  return presetsPending
}

export default function LivePanel({ tasks }: { tasks: EvalTask[] }) {
  const t = useT()
  const [targets, setTargets] = useState<RunTargets | null>(null)
  const [presets, setPresets] = useState<PgPreset[]>([])
  const [presetId, setPresetId] = useState<string>(() => loadString(PRESET_KEY, 'C0'))
  const [picked, setPicked] = useState<Set<string>>(() => new Set(loadPicked()))
  // 题目清单按领域折叠（与下方跑过的清单同款交互）：默认只展开已有勾选的领域——
  // 45 道题全铺开会把整个 section 撑得很长。折叠态不持久化，每次进屏按当前勾选重算。
  const [openDomains, setOpenDomains] = useState<Set<PgDomain>>(
    () => new Set(DOMAINS.filter((d) => tasks.some((x) => x.domain === d && picked.has(x.id)))),
  )
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  /** Full search/review query (domain/source/status/tag/model/preset/date). */
  const [filters, setFilters] = useState<RunsQuery>(() => loadFilters())
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const [sections, setSections] = useState(loadSections)
  /** Run ids ticked for bulk export (matrix cell checkbox). */
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  /** runIds created by the last 跑 click, so the panel can say how far that batch got. */
  const [batch, setBatch] = useState<string[]>([])
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toggleSection = (k: keyof typeof sections) =>
    setSections((prev) => ({ ...prev, [k]: !prev[k] }))

  // Nothing is pre-ticked: which questions to run is the user's call. Saved ids
  // are re-validated against the loaded set so a question that no longer exists
  // cannot linger in the batch.
  useEffect(() => {
    const valid = new Set(tasks.map((x) => x.id))
    setPicked((cur) => {
      const next = new Set([...cur].filter((id) => valid.has(id)))
      return next.size === cur.size ? cur : next
    })
  }, [tasks])

  useEffect(() => {
    try {
      localStorage.setItem(PICKED_KEY, JSON.stringify([...picked]))
    } catch { /* ignore */ }
  }, [picked])

  useEffect(() => { saveString(PRESET_KEY, presetId) }, [presetId])
  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify(filters))
    } catch { /* ignore */ }
  }, [filters])
  useEffect(() => {
    try {
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(sections))
    } catch { /* ignore */ }
  }, [sections])

  // A saved config that no longer exists would leave the <select> with no matching
  // option, so validate against what the server actually offers.
  useEffect(() => {
    if (presets.length === 0) return
    const first = presets[0]!.id
    setPresetId((cur) => (presets.some((p) => p.id === cur) ? cur : first))
    setFilters((cur) => {
      const pid = cur.presetId
      if (!pid || presets.some((p) => p.id === pid)) return cur
      return { ...cur, presetId: undefined }
    })
  }, [presets])

  useEffect(() => {
    let live = true
    loadTargets().then((r) => {
      if (live) setTargets(r)
    })
    loadPresets().then((r) => {
      if (live) setPresets(r)
    })
    return () => {
      live = false
    }
    // No language dep on purpose: t() is a fresh closure every render, so listing it
    // here would refetch on every render. Targets/presets are language-independent.
  }, [])

  const refresh = useCallback(() => {
    const q: Record<string, string> = { limit: String(filters.limit ?? 1000) }
    for (const [k, v] of Object.entries(filters)) {
      if (k === 'limit' || v == null || v === '') continue
      q[k] = String(v)
    }
    api
      .pgRuns(q)
      .then((r) => {
        setRuns(r)
        setActiveId((cur) => pickActiveRun(r, cur))
      })
      .catch(() => setRuns([]))
    api.pgMetrics().then(setMetrics).catch(() => setMetrics(null))
  }, [filters])

  useEffect(() => {
    setActiveId(null)
    refresh()
  }, [refresh])

  // Poll only while something is actually in flight; stop when all runs settle.
  const anyBusy = (runs ?? []).some((r) => r.status === 'queued' || r.status === 'running')
  useEffect(() => {
    if (!anyBusy) return
    // Self-scheduling. `anyBusy` stays true for the whole batch, so an effect that
    // scheduled a single timeout polled exactly once and then went quiet — results
    // only appeared after a manual reload. The loop stops when the effect is torn
    // down, which is what happens when the last run settles.
    let live = true
    const tick = (): void => {
      timer.current = setTimeout(() => {
        if (!live) return
        refresh()
        tick()
      }, POLL_MS)
    }
    tick()
    return () => {
      live = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [anyBusy, refresh])

  // Only real chat models can serve a live run. The Jev adjudication cards come
  // back from /targets with a key but no /chat/completions — counting them would
  // enable the button and then fail server-side with "no provider configured".
  // `!== 'decision'` (not `=== 'chat'`) so a backend that predates the `kind`
  // field still works instead of filtering every provider out.
  const usable = (targets?.providers ?? []).filter((p) => p.kind !== 'decision' && p.hasKey)
  const canRun = picked.size > 0 && usable.length > 0 && !busy

  const start = async () => {
    setBusy(true)
    setErr(null)
    setNotice(null)
    try {
      const r = await api.pgCreateRuns({
        taskIds: [...picked],
        presetId: presetId as PgPreset['id'],
      })
      if (r.error) {
        setErr(r.error)
      } else {
        setNotice(`${r.created.length}`)
        setBatch(r.created.map((c) => c.runId))
        // 详情面板必须跟着刚创建的那条走。refresh() 里的 `cur ?? …` 只是首次兜底、
        // 不会覆盖已有选择，所以不在这里显式切换的话，面板会一直停在旧 run 上——
        // 用户看到的就是「刚跑完，面板却显示上一条」。
        setActiveId(r.created[0]?.runId ?? null)
      }
      refresh()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const byDomain = useMemo(() => {
    const m = new Map<PgDomain, EvalTask[]>()
    for (const d of DOMAINS) m.set(d, tasks.filter((x) => x.domain === d))
    return m
  }, [tasks])

  const allDomainsOpen = DOMAINS.every((d) => openDomains.has(d))
  const toggleDomain = (d: PgDomain) =>
    setOpenDomains((prev) => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })

  // Batch progress. Runs go out one at a time, so without this the only feedback
  // was the cells quietly turning over in a collapsed table — no way to tell
  // whether the batch was halfway or done.
  const batchRuns = batch
    .map((id) => (runs ?? []).find((x) => x.runId === id))
    .filter((x): x is RunSummary => x != null)
  const batchTotal = batch.length
  const batchDone = batchRuns.filter((r) => r.status === 'scored' || r.status === 'error').length
  const batchFailed = batchRuns.filter((r) => r.status === 'error').length
  // Reloading mid-batch loses `batch`; fall back to whatever is still in flight.
  const inflight = (runs ?? []).filter((r) => r.status === 'queued' || r.status === 'running').length
  /** The task the scorecard compares configs for — whichever run is selected. */
  const activeTaskId = (runs ?? []).find((r) => r.runId === activeId)?.taskId ?? null

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="panel" style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <b style={{ color: 'var(--text)' }}>{t('playground.live.title')}</b>
            <div className="faint" style={{ fontSize: 12 }}>{t('playground.live.desc')}</div>
          </div>
          <ImportBar onImported={refresh} />
        </div>

        {/* 检索 / 复盘表单 */}
        <div className="pg-section-head" onClick={() => toggleSection('search')}>
          <span>{sections.search ? '▾' : '▸'} Search / review</span>
          <span className="faint" style={{ fontSize: 11 }}>
            Domain / source / status / failure tag / model / time
          </span>
        </div>
        {sections.search && (
          <SearchBar filters={filters} setFilters={setFilters} resultCount={(runs ?? []).length} />
        )}

        {/* 指标区：聚合表 + 失败×配置 + Pareto + 模型×Harness */}
        <div className="pg-section-head" onClick={() => toggleSection('metrics')}>
          <span>{sections.metrics ? '▾' : '▸'} Metrics / matrices</span>
          <span className="faint" style={{ fontSize: 11 }}>Success rate · lift · failure mode × config · Pareto · model × harness</span>
        </div>
        {sections.metrics && <MetricsPanel runs={runs ?? []} metrics={metrics} />}

        {/* 轨迹分叉对比：同任务双配置逐步对齐 + 失败模式转移 */}
        <div className="pg-section-head" onClick={() => toggleSection('compare')}>
          <span>{sections.compare ? '▾' : '▸'} Trajectory divergence</span>
          <span className="faint" style={{ fontSize: 11 }}>Same task, two configs, step-aligned · failure-mode transfer</span>
        </div>
        {sections.compare && <ComparePanel runs={runs ?? []} />}

        {usable.length === 0 && <div className="warn">{t('playground.live.noProvider')}</div>}
        {usable.length > 0 && targets?.kb && !targets.kb.ready && <div className="warn">{t('playground.live.kbNotReady')}</div>}

        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          <span className="faint">{t('playground.live.preset')}</span>
          <select value={presetId} onChange={(e) => setPresetId(e.target.value)} style={{ maxWidth: 420 }}>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} · {p.name} — {p.summary}
              </option>
            ))}
          </select>
        </label>

        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="faint" style={{ fontSize: 12 }}>
              {t('playground.live.pickTasks')} — {picked.size}/{tasks.length}
            </span>
            <button
              className="chip"
              onClick={() => setOpenDomains(allDomainsOpen ? new Set() : new Set(DOMAINS))}
              title={t('playground.live.collapseHint')}
            >
              {allDomainsOpen ? t('playground.live.collapseAll') : t('playground.live.expandAll')}
            </button>
          </div>
          {DOMAINS.map((d) => {
            const list = byDomain.get(d) ?? []
            const open = openDomains.has(d)
            return (
              <div key={d} style={{ display: 'grid', gap: 4, marginTop: 4 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button
                    onClick={() => toggleDomain(d)}
                    aria-expanded={open}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      display: 'flex',
                      gap: 6,
                      alignItems: 'center',
                      font: 'inherit',
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--text)',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>
                      {open ? '▾' : '▸'}
                    </span>
                    {t(`playground.live.domain.${d}`)}
                  </button>
                  <span className="faint" style={{ fontSize: 11 }}>
                    {list.filter((x) => picked.has(x.id)).length}/{list.length}
                  </span>
                  <button
                    className="chip"
                    onClick={() => {
                      setPicked(new Set([...picked, ...list.map((x) => x.id)]))
                      // 全选后展开本领域，否则勾选结果被折叠藏着看不见。
                      setOpenDomains((cur) => new Set(cur).add(d))
                    }}
                  >
                    {t('playground.live.pickAll')}
                  </button>
                  <button
                    className="chip"
                    onClick={() => {
                      const next = new Set(picked)
                      for (const x of list) next.delete(x.id)
                      setPicked(next)
                    }}
                  >
                    {t('playground.live.pickNone')}
                  </button>
                </div>
                {open &&
                  list.map((x) => {
                    const on = picked.has(x.id)
                    return (
                      <label
                        key={x.id}
                        style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 12, cursor: 'pointer' }}
                      >
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => {
                            const next = new Set(picked)
                            if (on) next.delete(x.id)
                            else next.add(x.id)
                            setPicked(next)
                          }}
                          style={{ flex: 'none' }}
                        />
                        <code style={{ minWidth: 30, flex: 'none' }}>{x.id}</code>
                        <span style={{ color: on ? 'var(--text)' : 'var(--text-dim, inherit)' }}>{x.title}</span>
                        {x.signature && <span className="badge" style={{ flex: 'none' }}>{t('playground.live.signature')}</span>}
                      </label>
                    )
                  })}
              </div>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="primary" disabled={!canRun} onClick={() => void start()}>
            {busy ? t('playground.live.running') : t('playground.live.run', { count: picked.size })}
          </button>
          {notice && <span className="faint" style={{ fontSize: 12 }}>#{notice}</span>}
          {err && <span style={{ color: 'var(--red)', fontSize: 12 }}>{err}</span>}
        </div>

        {batchTotal > 0 && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span className="faint" style={{ fontSize: 12 }}>
              {batchDone >= batchTotal
                ? t('playground.live.batchDone', { total: batchTotal, failed: batchFailed })
                : t('playground.live.batchProgress', { done: batchDone, total: batchTotal, failed: batchFailed })}
            </span>
            <div style={{ height: 4, borderRadius: 2, background: 'var(--border)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  width: `${Math.round((batchDone / batchTotal) * 100)}%`,
                  background: batchDone >= batchTotal ? 'var(--green)' : 'var(--accent)',
                  transition: 'width 200ms linear',
                }}
              />
            </div>
          </div>
        )}
        {batchTotal === 0 && inflight > 0 && (
          <span className="faint" style={{ fontSize: 12 }}>{t('playground.live.inflight', { count: inflight })}</span>
        )}
      </div>

      <BulkToolbar
        selected={[...selected]}
        onClear={() => setSelected(new Set())}
        onChanged={refresh}
      />
      <ResultMatrix
        runs={runs ?? []}
        activeId={activeId}
        onPick={setActiveId}
        presets={presets}
        filterFingerprint={filters.fingerprint ?? ''}
        onFilter={(fp) => setFilters((cur) => ({ ...cur, fingerprint: fp || undefined }))}
        selected={selected}
        onToggle={(id) =>
          setSelected((cur) => {
            const next = new Set(cur)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          })
        }
      />
      {/* One question, all configs side by side. Sits above the detail because the
          detail is the drill-down and this is the comparison. */}
      {activeTaskId && (
        <Scorecard runs={(runs ?? []).filter((r) => r.taskId === activeTaskId)} presets={presets} />
      )}

      {activeId && (
        <RunDetailView
          runId={activeId}
          tasks={tasks}
          onDeleted={() => { setActiveId(null); refresh() }}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

// ── result matrix: one row per question, one column per harness config ──────
//
// A flat run list forced the reader to flip the config filter back and forth to
// compare a question across configs — the same question appeared as several rows
// scattered through the list. Here a question is one row and each harness config
// is a column, so the comparison is a single glance.
//
// Order is General → Legal → Security, then the question number. The number is
// parsed so G2 comes before G10 (natural sort, not string sort).

function ResultMatrix({
  runs,
  activeId,
  onPick,
  presets,
  filterFingerprint,
  onFilter,
  selected,
  onToggle,
}: {
  runs: RunSummary[]
  activeId: string | null
  onPick: (id: string) => void
  presets: PgPreset[]
  /** Selected configuration, identified by fingerprint (stable, not a label). */
  filterFingerprint: string
  onFilter: (fingerprint: string) => void
  selected: Set<string>
  onToggle: (id: string) => void
}) {
  const t = useT()
  const rows = useMemo(() => buildRows(runs), [runs])

  /** Contiguous domain groups — `rows` already comes back sorted by domain. */
  const groups = useMemo(() => {
    const out: { domain: PgDomain; rows: ResultRow[] }[] = []
    for (const r of rows) {
      const last = out[out.length - 1]
      if (last && last.domain === r.domain) last.rows.push(r)
      else out.push({ domain: r.domain, rows: [r] })
    }
    return out
  }, [rows])

  // Collapsed by default: with 45 questions the table pushed the trajectory
  // panel below off screen. The domain holding the selected run opens itself, so
  // clicking a cell never hides the thing you just picked.
  const [expanded, setExpanded] = useState<Set<PgDomain>>(new Set())
  const activeDomain = runs.find((r) => r.runId === activeId)?.domain ?? null
  useEffect(() => {
    if (!activeDomain) return
    setExpanded((prev) => (prev.has(activeDomain) ? prev : new Set(prev).add(activeDomain)))
  }, [activeDomain])
  const allOpen = groups.length > 0 && groups.every((g) => expanded.has(g.domain))
  const toggle = (d: PgDomain) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })

  // Everything below is keyed by configuration fingerprint, so a configuration
  // is one column / one count no matter which code path created the run.
  const presetFp = new Map(presets.map((p) => [p.id, fingerprint(p.config)]))

  const counts = new Map<string, { total: number; passed: number }>()
  for (const r of runs) {
    const cur = counts.get(r.fingerprint) ?? { total: 0, passed: 0 }
    cur.total++
    if (r.success === true) cur.passed++
    counts.set(r.fingerprint, cur)
  }

  // Only configs that actually produced a run get a column, in preset order;
  // anything else (an evolved configuration) follows, ordered by its name.
  const colMap = new Map<string, { key: string; label: string; title: string | null }>()
  for (const r of runs) {
    if (!colMap.has(r.fingerprint)) {
      colMap.set(r.fingerprint, { key: r.fingerprint, label: r.configLabel, title: r.configTitle })
    }
  }
  const presetRank = new Map(presets.map((p, i) => [fingerprint(p.config), i]))
  const cols = [...colMap.values()].sort((a, b) => {
    const ra = presetRank.get(a.key) ?? 99
    const rb = presetRank.get(b.key) ?? 99
    return ra !== rb ? ra - rb : a.label.localeCompare(b.label)
  })
  const tmpl = `minmax(190px, 1fr) repeat(${Math.max(cols.length, 1)}, 96px)`

  return (
    <div className="panel" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="faint" style={{ fontSize: 12 }}>{t('playground.live.runList')}</span>
        <button className={`chip ${filterFingerprint === '' ? 'on' : ''}`} onClick={() => onFilter('')}>
          {t('playground.live.filterAll')} ({runs.length})
        </button>
        {presets.map((pr) => {
          const fp = presetFp.get(pr.id) ?? ''
          const c = counts.get(fp)
          return (
            <button
              key={pr.id}
              className={`chip ${filterFingerprint === fp ? 'on' : ''}`}
              onClick={() => onFilter(filterFingerprint === fp ? '' : fp)}
              title={pr.summary}
            >
              {pr.id}
              {c ? ` ${c.passed}/${c.total}` : ' 0'}
            </button>
          )
        })}
        {groups.length > 0 && (
          <button
            className="chip"
            onClick={() => setExpanded(allOpen ? new Set() : new Set(groups.map((g) => g.domain)))}
            title={t('playground.live.collapseHint')}
          >
            {allOpen ? t('playground.live.collapseAll') : t('playground.live.expandAll')}
          </button>
        )}
      </div>

      {runs.length === 0 ? (
        <div className="loading">{t('playground.live.empty')}</div>
      ) : (
        <>
          <div className="faint" style={{ fontSize: 11 }}>{t('playground.live.matrixHint')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: tmpl, gap: 6, alignItems: 'stretch' }}>
            <span className="faint" style={{ fontSize: 11 }}>{t('playground.live.pickTasks')}</span>
            {cols.map((c) => (
              <span
                key={c.key}
                className="faint"
                style={{ fontSize: 11, textAlign: 'center' }}
                title={c.title ?? undefined}
              >
                {c.label}
              </span>
            ))}

            {groups.flatMap((g) => {
              const open = expanded.has(g.domain)
              const head = (
                <button
                  key={`dom-${g.domain}`}
                  onClick={() => toggle(g.domain)}
                  style={{
                    gridColumn: '1 / -1',
                    display: 'flex',
                    gap: 6,
                    alignItems: 'center',
                    marginTop: 4,
                    padding: '6px 0 0',
                    border: 'none',
                    borderTop: '1px solid var(--border)',
                    background: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    font: 'inherit',
                    fontSize: 11,
                    fontWeight: 600,
                    color: 'var(--text)',
                  }}
                >
                  <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>
                    {open ? '▾' : '▸'}
                  </span>
                  {t(`playground.live.domain.${g.domain}`)}
                  <span className="faint" style={{ fontWeight: 400 }}>
                    {t('playground.live.questionCount', { count: g.rows.length })}
                  </span>
                </button>
              )
              if (!open) return [head]
              return [
                head,
                ...g.rows.flatMap((row) => [
                  <div
                    key={`task-${row.taskId}`}
                    style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}
                  >
                    <code style={{ fontFamily: 'var(--mono)', fontSize: 11, flex: 'none', minWidth: 28 }}>
                      {row.taskId}
                    </code>
                    <span
                      style={{
                        fontSize: 12,
                        color: 'var(--text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={row.taskTitle}
                    >
                      {row.taskTitle}
                    </span>
                  </div>,
                  ...cols.map((c) => {
                    const cell = row.cells.get(c.key) ?? null
                    return (
                      <ResultCell
                        key={`${row.taskId}-${c.key}`}
                        cell={cell}
                        active={cell?.run.runId === activeId}
                        onPick={onPick}
                        selected={cell ? selected.has(cell.run.runId) : false}
                        onToggle={onToggle}
                      />
                    )
                  }),
                ]),
              ]
            })}
          </div>
        </>
      )}
    </div>
  )
}

function ResultCell({
  cell,
  active,
  onPick,
  selected,
  onToggle,
}: {
  cell: { run: RunSummary; count: number } | null
  active: boolean
  onPick: (id: string) => void
  selected: boolean
  onToggle: (id: string) => void
}) {
  const t = useT()
  if (!cell) {
    return (
      <div
        style={{
          minHeight: 34,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '4px 6px',
          borderRadius: 6,
          border: '1px dashed var(--border)',
          fontSize: 11,
          color: 'var(--text-faint)',
          opacity: 0.7,
        }}
        title={t('playground.live.notRun')}
      >
        —
      </div>
    )
  }
  const { run, count } = cell
  const errored = run.status === 'error'
  const pending = run.status === 'queued' || run.status === 'running'
  const passed = run.success === true
  const failed = run.success === false
  const bg = errored || failed ? 'rgba(220, 38, 38, .08)' : passed ? 'rgba(5, 150, 105, .10)' : 'var(--bg-panel2)'
  const fg = errored || failed ? 'var(--red)' : passed ? 'var(--green)' : 'var(--text-dim)'
  const mark = errored ? '!' : run.success == null ? '·' : passed ? '✓' : '✗'
  const title = [
    run.configLabel,
    t(`playground.live.status.${run.status}`),
    runTime(run.createdAt),
    run.score != null ? `score ${run.score.toFixed(2)}` : null,
    run.tokens != null ? t('playground.live.tokenCost', { tokens: run.tokens, ms: run.latencyMs ?? 0 }) : null,
    // L3 USD cost from the provider×model price table; omitted when unpriced.
    run.costUsd != null ? `$${run.costUsd < 0.01 ? run.costUsd.toFixed(4) : run.costUsd.toFixed(2)}` : null,
    run.hasTrajectory ? t('playground.live.withTrajectory') : t('playground.live.metricsOnly'),
    count > 1 ? t('playground.live.latestOf', { count }) : null,
    run.source === 'imported' ? t('playground.live.imported') : null,
    run.error,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div
      onClick={() => onPick(run.runId)}
      title={title}
      style={{
        position: 'relative',
        minHeight: 34,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        padding: '4px 6px',
        borderRadius: 6,
        cursor: 'pointer',
        textAlign: 'center',
        background: bg,
        color: fg,
        border: active ? '1px solid var(--accent)' : selected ? '1px solid var(--violet)' : '1px solid var(--border)',
        // 出错的格子左侧压一道红条，别和正常结果混在一起看不出来
        borderLeft: errored ? '3px solid var(--red)' : undefined,
        opacity: pending ? 0.7 : 1,
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      <input
        type="checkbox"
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={() => onToggle(run.runId)}
        title="Add to the bulk export selection"
        style={{ position: 'absolute', top: 2, right: 2, width: 11, height: 11, flex: 'none' }}
      />
      <span>{mark}</span>
      {run.score != null && (
        <span style={{ fontSize: 10, fontWeight: 400, opacity: 0.85 }}>{run.score.toFixed(2)}</span>
      )}
      {pending && (
        <span style={{ fontSize: 9, fontWeight: 400 }}>{t(`playground.live.status.${run.status}`)}</span>
      )}
    </div>
  )
}

// ── run detail: trajectory / answer / attack chain ──────────────────────────

function RunDetailView({
  runId,
  tasks,
  onDeleted,
  onChanged,
}: {
  runId: string
  tasks: EvalTask[]
  onDeleted: () => void
  onChanged: () => void
}) {
  const t = useT()
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [trajErr, setTrajErr] = useState<string | null>(null)
  const [tab, setTab] = useState<'trajectory' | 'answer' | 'security'>('trajectory')
  const [deleting, setDeleting] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)
  /** Bump to re-fetch the detail after a rescore / mutation. */
  const [nonce, setNonce] = useState(0)

  /**
   * Delete this run. Confirmation names the task and config so the dialog says
   * which cell is disappearing — "delete?" alone is unreadable once several runs
   * of the same question are on screen. Deleting also drops the trajectory and
   * verdict, which is the point: the run is counted in every aggregate, and
   * leaving an orphan trajectory behind would make the run look metrics-only.
   */
  const remove = async () => {
    if (!detail || deleting) return
    if (!window.confirm(t('playground.live.deleteConfirm', {
      task: detail.taskId,
      preset: detail.configLabel,
      n: detail.events.length,
    }))) return
    setDeleting(true)
    setDelErr(null)
    try {
      await api.pgDeleteRun(runId)
      onDeleted()
    } catch (e) {
      setDelErr(e instanceof Error ? e.message : String(e))
      setDeleting(false)
    }
  }

  useEffect(() => {
    setDetail(null)
    setTrajErr(null)
    let live = true
    let timer: ReturnType<typeof setTimeout> | null = null
    // 未落定的 run 要持续跟：只取一次的话，刚创建那条会永远停在 queued/running 的快照上，
    // 和「跑完面板不更新」是同一个毛病。落定（scored/error）后自然停止。
    const tick = (): void => {
      api
        .pgRun(runId)
        .then((d) => {
          if (!live) return
          setDetail(d)
          if (d.status === 'queued' || d.status === 'running') timer = setTimeout(tick, POLL_MS)
        })
        .catch((e: unknown) => {
          if (live) setTrajErr(e instanceof Error ? e.message : String(e))
        })
    }
    tick()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [runId, nonce])

  if (trajErr) {
    return (
      <div className="panel loading" style={{ color: 'var(--red)' }}>
        {t('playground.live.corruptTrajectory')} ({trajErr})
      </div>
    )
  }
  if (!detail) return <div className="panel loading">{t('playground.loading')}</div>

  return (
    <div className="panel" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <code>{detail.taskId}</code>
        <b style={{ color: 'var(--text)', fontSize: 13 }}>{detail.taskTitle}</b>
        <span className="faint" style={{ fontSize: 11 }}>
          {detail.configLabel} · {detail.fingerprint.slice(0, 10)} · ladder {detail.configVersion.ladderRung}
        </span>
        {/* When this run happened. Without it there is no way to tell a result from
            ten minutes ago from one from last week. */}
        <span className="faint" style={{ fontSize: 11 }}>{runTime(detail.createdAt)}</span>
        <a className="chip" href={api.pgExportUrl(detail.runId)} download>
          {t('playground.live.export')}
        </a>
        {/* A run still in flight must not be deletable — the server refuses it
            and the button would only ever produce an error. */}
        {detail.status !== 'queued' && detail.status !== 'running' && (
          <button
            className="chip"
            onClick={() => void remove()}
            disabled={deleting}
            title={t('playground.live.deleteHint')}
            style={{ color: deleting ? 'var(--text-dim)' : 'var(--red)' }}
          >
            {deleting ? t('playground.live.deleting') : t('playground.live.delete')}
          </button>
        )}
        {delErr && <span style={{ color: 'var(--red)', fontSize: 11 }}>{delErr}</span>}
      </div>

      <div className="screen-nav">
        {(['trajectory', 'answer', 'security'] as const).map((k, i) => (
          <button
            key={k}
            className={`screen-nav-item ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k)}
            style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}
          >
            <span className="screen-nav-num">{'ABC'[i]}</span>
            {t(`playground.live.tab.${k}`)}
          </button>
        ))}
      </div>

      {tab === 'trajectory' &&
        // Honest empty state — never fall back to a previous run's events.
        (detail.events.length === 0 ? (
          <div className="loading">{t('playground.live.emptyTrajectory')}</div>
        ) : (
          <Trajectory detail={detail} />
        ))}

      {tab === 'answer' && (
        <AnswerView
          detail={detail}
          tasks={tasks}
          query={tasks.find((x) => x.id === detail.taskId)?.query ?? null}
          onRescored={() => { setNonce((n) => n + 1); onChanged() }}
        />
      )}

      {tab === 'security' && <SecurityView detail={detail} />}
    </div>
  )
}

/**
 * What the harness itself did in this run, next to the events that prove it.
 *
 * A trajectory alone cannot answer "did the C1 switch do anything" — it shows what
 * the model did. The config line only says what was requested. This strip is the
 * join between the two, so a switch that is on but never acts is visible as such
 * instead of hiding behind an identical-looking event stream.
 */
function HarnessModules({ detail }: { detail: RunDetail }) {
  const t = useT()
  const mods = moduleActivity(detail.config, detail.mounts, detail.events, detail.configVersion.controlsSnapshot)
  if (mods.length === 0) {
    return (
      <div className="panel faint" style={{ fontSize: 12 }}>
        {t('playground.live.modulesBaseline')}
      </div>
    )
  }
  const tone = (s: ModuleActivity['state']): string =>
    s === 'fired' ? 'var(--green, #2e7d32)' : s === 'prompt' ? 'var(--text)' : 'var(--border)'
  const mark = (s: ModuleActivity['state']): string => (s === 'fired' ? '●' : s === 'prompt' ? '○' : '◌')
  return (
    <div className="panel" style={{ display: 'grid', gap: 3, fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ color: 'var(--text)' }}>{t('playground.live.modules')}</b>
        <span className="faint" style={{ fontSize: 11 }}>{t('playground.live.modulesHint')}</span>
      </div>
      {mods.map((m) => (
        <div key={m.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
          <span style={{ color: tone(m.state), minWidth: 12 }}>{mark(m.state)}</span>
          <span style={{ color: 'var(--text)', minWidth: 190 }}>{m.label}</span>
          <code style={{ fontSize: 11, minWidth: 130 }}>{m.value}</code>
          <span className="faint" style={{ fontSize: 11 }}>
            {t(`playground.live.moduleState.${m.state}`)}
            {m.evidence ? ` · ${m.evidence}` : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

/** Module chips for one event; empty falls back to the event's author. */
function ModuleTags({ of }: { of: ModuleActivity[] }) {
  if (of.length === 0) return <span className="faint" style={{ fontSize: 10, minWidth: 150 }} />
  return (
    <span style={{ display: 'inline-flex', gap: 4, minWidth: 150, flexWrap: 'wrap' }}>
      {of.map((m) => (
        <span
          key={m.key}
          title={`${m.label} = ${m.value}`}
          style={{
            fontSize: 10,
            lineHeight: '16px',
            padding: '0 5px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
            color: 'var(--accent)',
            background: 'var(--bg-panel2)',
            border: '1px solid var(--border)',
          }}
        >
          {m.label}
        </span>
      ))}
    </span>
  )
}

/** Step-by-step replay of the event stream. */
function Trajectory({ detail }: { detail: RunDetail }) {
  const t = useT()
  const events = detail.events
  const [cursor, setCursor] = useState(events.length)
  const upto = events.slice(0, cursor)
  const last = upto[upto.length - 1]
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <HarnessModules detail={detail} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type="range"
          min={0}
          max={events.length}
          value={cursor}
          onChange={(e) => setCursor(Number(e.target.value))}
          style={{ flex: 1 }}
        />
        <span className="faint" style={{ fontSize: 11, minWidth: 64, textAlign: 'right' }}>
          {cursor}/{events.length}
        </span>
        <button className="chip" onClick={() => setCursor(events.length)}>
          ⏭
        </button>
      </div>
      {last ? (
        <div className="panel" style={{ display: 'grid', gap: 2, fontSize: 12 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <b style={{ color: 'var(--text)' }}>
              {stepOf(last) != null && `step ${stepOf(last)} · `}
              {last.type}
            </b>
            <ModuleTags of={eventAttributions(last, detail.config, detail.mounts, detail.configVersion.controlsSnapshot)} />
          </div>
          <span className="faint">{summarizeEvent(last)}</span>
        </div>
      ) : (
        <div className="loading">{t('playground.live.emptyTrajectory')}</div>
      )}
      <div style={{ display: 'grid', gap: 2, maxHeight: 260, overflow: 'auto', fontSize: 11 }}>
        {upto.map((e) => (
          <div key={e.id} style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
            <code className="faint" style={{ minWidth: 34 }}>
              {stepOf(e) ?? '·'}
            </code>
            <span style={{ minWidth: 132 }}>{e.type}</span>
            <ModuleTags of={eventAttributions(e, detail.config, detail.mounts, detail.configVersion.controlsSnapshot)} />
            <span className="faint">{summarizeEvent(e)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** run.started / run.finished have no step; the rest do. */
function stepOf(e: HarnessEvent): number | null {
  return 'step' in e ? e.step : null
}

function summarizeEvent(e: HarnessEvent): string {
  switch (e.type) {
    case 'run.started':
      return `${e.model} · ${e.task}`
    case 'model.request':
      return `${e.blocks.length} blocks · ~${e.estTokens} tok`
    case 'model.response':
      return `${e.thought.slice(0, 90)}${e.thought.length > 90 ? '…' : ''}`
    case 'tool.call':
      return `${e.tool} ${e.argsSummary.slice(0, 60)}`
    case 'tool.result':
      return `${e.tool} · ${e.summary}`
    case 'hook.decision':
      return `${e.hook}: ${e.verdict} — ${e.reason}`
    case 'permission.request':
      return `${e.scope} (${e.riskLevel})`
    case 'permission.denied':
      return `${e.scope} @${e.gate} — ${e.reason}`
    case 'permission.granted':
      return `${e.scope} via ${e.via}`
    case 'router.decision':
      return `${e.tool} → ${e.route} (${e.matchedRule})`
    case 'verifier.verdict':
      return `${e.verifier}: ${e.verdict}${e.failureTag ? ` · ${e.failureTag}` : ''}`
    case 'legal.assertion':
      return `${e.citedAuthority} → ${e.label}`
    case 'shaper.fire':
      return `${e.shaper} freed ${e.freedTokens} tok`
    case 'failure.tag':
      return `${e.mast} (${e.confidence})`
    case 'compact.boundary':
      return `${e.beforeTokens} → ${e.afterTokens}`
    case 'optimizer.fire':
      return `${e.component} · ${e.action}`
    case 'sensor.lint':
      return `${e.lint}: ${e.verdict}`
    case 'agent.fork':
      return `${e.childId} · ${e.purpose}`
    case 'agent.join':
      return `${e.childId} · ${e.summary}`
    case 'harness.mutation':
      return `${e.commitId} · ${e.approvedBy}`
    case 'run.finished':
      return `tokens ${e.tokens} · p50 ${e.latencyP50}ms`
    default:
      return ''
  }
}

/**
 * The question as it was actually sent, above the answer it produced. The query
 * used to appear nowhere in the run detail at all — the trajectory only records
 * the task id — so there was no way to read what was asked next to what came back.
 */
function AnswerView({
  detail,
  tasks,
  query,
  onRescored,
}: {
  detail: RunDetail
  tasks: EvalTask[]
  query: string | null
  onRescored: () => void
}) {
  const t = useT()
  const v = detail.verdict
  const unlinked = detail.source === 'imported' && detail.taskId === 'IMPORTED'
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {unlinked && <RescoreImport runId={detail.runId} tasks={tasks} onRescored={onRescored} />}
      <div style={{ display: 'grid', gap: 4 }}>
        <b style={{ color: 'var(--text)', fontSize: 12 }}>{t('playground.live.question')}</b>
        <div
          className="panel"
          style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--bg-panel2)' }}
        >
          {query || t('playground.live.noQuery')}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 4 }}>
        <b style={{ color: 'var(--text)', fontSize: 12 }}>{t('playground.live.finalAnswer')}</b>
        <div className="panel" style={{ whiteSpace: 'pre-wrap', fontSize: 12, maxHeight: 420, overflow: 'auto' }}>
          {detail.answer || '(empty)'}
        </div>
      </div>

      {/* Why it scored what it scored: pass/fail alone says nothing about which
          point failed, so the per-point breakdown belongs next to the answer. */}
      <div style={{ display: 'grid', gap: 4 }}>
        <b style={{ color: 'var(--text)', fontSize: 12 }}>{t('playground.live.scoreDetail')}</b>
        {v ? (
          <ScoreReport result={v} />
        ) : (
          <span className="faint" style={{ fontSize: 12 }}>{t('playground.live.notScored')}</span>
        )}
        {detail.error && <span style={{ fontSize: 12, color: 'var(--red)' }}>{detail.error}</span>}
      </div>

      <JevReading detail={detail} />
    </div>
  )
}

/**
 * 详情页的判定读数区：**只呈现 mercury（判定模型）的读数**，旧判分器（jev-1.13.0）
 * 的读数一律不显示。
 *
 * 三种情况：
 *   1. 主槽是 mercury（回填后所有 run）→ 完整区块：徽标 / 型号 / 时延 / 通过与否 /
 *      原因与报错 / 原始读数 / 判定理由；
 *   2. 主槽是旧判分器、侧槽留着 2026-10-12 那轮 mercury 的 choice（回填前的老 run）
 *      → 只显示型号 + 那条 choice 读数；
 *   3. 连 mercury 的读数都没有 → 一行"不再呈现"。
 *
 * 「取哪条读数」与 Scorecard 共用 `pickUiJudgeReading`，两处不可能各说一套。
 */
function JevReading({ detail }: { detail: RunDetail }) {
  const t = useT()
  const jv = detail.jevResult
  const picked = pickUiJudgeReading(jv)
  // 主槽就是判定模型的读数：这次读数是本条 run 的定分依据，理由与报错都随它一起显示。
  const full = picked != null && isUiJudgeModel(jv?.model)
  // 未通过的 run：逐条要点里不达标的那些（不是「满足」的）红底标出来，一眼能看到是哪条拖的。
  const failed = jv?.success === false
  const isBadPoint = (p: { state: string | null }): boolean => p.state != null && p.state !== 'satisfied'
  const hasBadPoint = (jv?.points ?? []).some(isBadPoint)
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <b style={{ color: 'var(--text)', fontSize: 12 }}>{t('playground.live.jevTitle')}</b>
      {!picked ? (
        <span className="faint" style={{ fontSize: 12 }}>
          {jv ? t('playground.live.jevLegacy') : t('playground.live.jevOff')}
        </span>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge">{picked.model}</span>
            {picked.latencyMs != null && (
              <span className="faint" style={{ fontSize: 11 }}>{picked.latencyMs}ms</span>
            )}
            {full && jv?.success != null && (
              <span className="faint" style={{ fontSize: 11 }}>
                {jv.success ? `✓ ${t('playground.live.judgePass')}` : `✗ ${t('playground.live.judgeFail')}`}
              </span>
            )}
          </div>

          {/* 判定模型的原始读数：它给出结论的依据，逐项原样回显。 */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'max-content minmax(0,1fr)',
              columnGap: 10,
              rowGap: 4,
              fontSize: 12,
              alignItems: 'baseline',
            }}
          >
            <span className="faint">{t('playground.live.cmpJev')}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>{uiJudgeReadingLine(picked)}</span>
          </div>

          {full && jv?.reason && <span className="faint" style={{ fontSize: 12 }}>{jv.reason}</span>}
          {full && jv?.error && <span style={{ color: 'var(--red)', fontSize: 12 }}>{jv.error}</span>}

          {/* 判分依据：模型不写自由文本，这段是代码按我们写的准绳把上面读数翻出来的。 */}
          {full && jv?.basis && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'max-content minmax(0,1fr)',
                columnGap: 10,
                rowGap: 4,
                fontSize: 12,
                alignItems: 'baseline',
              }}
            >
              <span className="faint">{t('playground.live.judgeBasis')}</span>
              <span style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>{jv.basis}</span>
            </div>
          )}

          {/* 逐条要点核对：题目要什么 / 答复写了什么 / 对不上在哪 —— 三样同屏。
              状态是模型在五档准绳里挑的一档，段落是模型指认的段号，
              引出来的那句原文由代码从答复里取，不经模型转述。
              本条 run 未通过时：不达标（非「满足」）的要点红底标出；
              若条条都达标，写明未通过来自整体读数，不让"没一处红"看起来像漏了。 */}
          {full && jv && (jv.points?.length ?? 0) > 0 && (
            <div style={{ display: 'grid', gap: 6 }}>
              <span className="faint" style={{ fontSize: 11 }}>{t('playground.live.pointCheck')}</span>
              {jv.points!.map((pt, i) => {
                const bad = failed && isBadPoint(pt)
                return (
                  <div
                    key={`${pt.label}-${i}`}
                    style={{
                      display: 'grid',
                      gap: 2,
                      fontSize: 12,
                      padding: bad ? '4px 6px' : 0,
                      borderRadius: 4,
                      background: bad ? 'rgba(220,38,38,0.10)' : undefined,
                      border: bad ? '1px solid rgba(220,38,38,0.45)' : '1px solid transparent',
                    }}
                  >
                    <span style={bad ? { color: 'var(--red)' } : undefined}>
                      {bad ? '✗ ' : ''}
                      {i + 1}. "{pt.label}" →{' '}
                      <b>{JEV_POINT_STATE_LABEL[pt.state ?? ''] ?? pt.state ?? '—'}</b>
                      {pt.stateConfidence != null && (
                        <span className={bad ? undefined : 'faint'}>({Math.round(pt.stateConfidence * 100)}%)</span>
                      )}
                      {pt.paragraph != null ? ` · answer paragraph ${pt.paragraph}` : ' · no matching paragraph in the answer'}
                    </span>
                    {pt.paragraphText && (
                      <span className="faint" style={{ fontSize: 11, whiteSpace: 'pre-wrap' }}>
                        "{pt.paragraphText}"
                      </span>
                    )}
                  </div>
                )
              })}
              {failed && !hasBadPoint && (
                <span className="faint" style={{ fontSize: 11, color: 'var(--red)' }}>
                  {t('playground.live.pointCheckAllOk')}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function SecurityView({ detail }: { detail: RunDetail }) {
  const t = useT()
  const { observed, blastRadius } = detail.security
  if (!observed) {
    return <div className="loading">{t('playground.live.noSecurity')}</div>
  }
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {observed ? (
        <ChainColumn
          title={t('playground.live.observed')}
          hint={observed.deriveVersion}
          rows={observed.observedStages}
          radius={blastRadius.filter((b) => b.reached).map((b) => b.target)}
        />
      ) : (
        <div className="loading">{t('playground.live.emptyTrajectory')}</div>
      )}
    </div>
  )
}

function ChainColumn({
  title,
  hint,
  rows,
  radius,
}: {
  title: string
  hint?: string
  rows: { stage: KillChainStage; status: string; note: string; blockedBy?: string }[]
  radius: string[]
}) {
  const t = useT()
  const byStage = new Map(rows.map((r) => [r.stage, r]))
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <b style={{ color: 'var(--text)', fontSize: 12 }}>
        {title}
        {hint && <span className="faint" style={{ fontWeight: 400 }}> · {hint}</span>}
      </b>
      {KILL_CHAIN.map((stage) => {
        const row = byStage.get(stage)
        const status = row?.status ?? 'n/a'
        const key = status === 'n/a' ? 'na' : status === 'not-reached' ? 'notReached' : status
        const badgeClass = status === 'blocked' || status === 'safe' ? 'ok' : status === 'breached' ? 'bad' : 'warn'
        return (
          <div key={stage} style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'baseline' }}>
            <span style={{ minWidth: 130 }}>{KILL_CHAIN_LABEL[stage]}</span>
            <span className={`badge ${badgeClass}`}>
              {t(`playground.live.stage.${key}`)}
            </span>
            {row?.blockedBy && (
              <span className="faint">{t('playground.live.blockedBy', { control: row.blockedBy })}</span>
            )}
            {row?.note && <span className="faint">{row.note}</span>}
          </div>
        )
      })}
      {radius.length > 0 && (
        <div className="faint" style={{ fontSize: 11 }}>
          {t('playground.live.blastRadius')}: {radius.join(' · ')}
        </div>
      )}
    </div>
  )
}
