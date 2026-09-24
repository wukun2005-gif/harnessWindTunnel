import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import type {
  PlaygroundTaskList,
  EvalTask,
  ScoreResult,
  PgSplit,
  PgDomain,
  ScorerType,
} from '../../../shared/playground'
import { ScoreReport } from './ScoreReport'
import { JevJudgeBlock } from './JevPanel'
import AnalysisPanel from './AnalysisPanel'
import { ackBatchComplete, assertionScenario, cancelBatch, getBatchSnapshot, playgroundScenario, ragScenario, resetBatch, setBatchSelection, startBatch, subscribeBatch, tagScenario, type BatchScenario } from './batchRunner'
import type { JevJudgeResult, JevSettingsView } from '../../../shared/jev'

export default function Playground() {
  const t = useT()
  const [tab, setTab] = useState<'evalset' | 'sandbox' | 'batch' | 'analysis'>('evalset')
  const [sandboxTaskId, setSandboxTaskId] = useState<string | undefined>(undefined)
  const [data, setData] = useState<PlaygroundTaskList | null>(null)
  const [failed, setFailed] = useState(false)
  const [jev, setJev] = useState<JevSettingsView | null>(null)
  const batchSnap = useSyncExternalStore(subscribeBatch, getBatchSnapshot)

  // 一键全测自然跑完后自动跳入分析视图（只跳一次；取消不跳）。
  useEffect(() => {
    if (batchSnap.completed) {
      ackBatchComplete()
      setTab('analysis')
    }
  }, [batchSnap.completed])

  useEffect(() => {
    let live = true
    api
      .pgJevSettings()
      .then((r) => {
        if (live) setJev(r.settings)
      })
      .catch(() => {
        // 开关在设置屏；这里只读状态用于锁按钮，读不到按关着处理。
      })
    return () => {
      live = false
    }
  }, [t])

  useEffect(() => {
    let live = true
    api
      .pgTasks()
      .then((d) => {
        if (live) setData(d)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">{t('playground.eyebrow')}</span>
        <h1>{t('playground.title')}</h1>
        <span className="q">{t('playground.subtitle')}</span>
      </div>

      <div className="screen-nav">
        <button
          className={`screen-nav-item ${tab === 'evalset' ? 'active' : ''}`}
          onClick={() => setTab('evalset')}
          style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}
        >
          <span className="screen-nav-num">A</span>{t('playground.tab.evalset', { count: data?.total ?? 45 })}
        </button>
        <button
          className={`screen-nav-item ${tab === 'sandbox' ? 'active' : ''}`}
          onClick={() => setTab('sandbox')}
          style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}
        >
          <span className="screen-nav-num">B</span>{t('playground.tab.sandbox')}
        </button>
        <button
          className={`screen-nav-item ${tab === 'batch' ? 'active' : ''}`}
          onClick={() => setTab('batch')}
          style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}
        >
          <span className="screen-nav-num">C</span>{t('playground.tab.batch')}
        </button>
        <button
          className={`screen-nav-item ${tab === 'analysis' ? 'active' : ''}`}
          onClick={() => setTab('analysis')}
          style={{ border: 'none', cursor: 'pointer', font: 'inherit' }}
        >
          <span className="screen-nav-num">D</span>{t('playground.tab.analysis')}
        </button>
      </div>

      {!data ? (
        <div className="panel loading">{failed ? t('playground.loadFail') : t('playground.loading')}</div>
      ) : tab === 'evalset' ? (
        <EvalSetPanel data={data} onTry={(id) => {
          setSandboxTaskId(id)
          setTab('sandbox')
        }} />
      ) : tab === 'sandbox' ? (
        <Sandbox data={data} initialTaskId={sandboxTaskId} jevEnabled={!!jev?.enabled} />
      ) : tab === 'batch' ? (
        <BatchPanel data={data} jevEnabled={!!jev?.enabled} />
      ) : (
        <AnalysisPanel tasks={data.tasks} />
      )}
    </div>
  )
}

// ── Panel A: the eval set ──────────────────────────────────────────────────

function EvalSetPanel({ data, onTry }: { data: PlaygroundTaskList; onTry: (id: string) => void }) {
  const t = useT()
  const [expanded, setExpanded] = useState<string | null>(null)
  const splits: PgSplit[] = ['repair', 'gate', 'scorecard']
  const domains: PgDomain[] = ['general', 'legal', 'security']

  const counts = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of data.tasks) m[`${t.split}:${t.domain}`] = (m[`${t.split}:${t.domain}`] ?? 0) + 1
    return m
  }, [data])

  const byDomain = (dm: PgDomain) => data.tasks.filter((x) => x.domain === dm).length
  const bySplit = (sp: PgSplit) => data.tasks.filter((x) => x.split === sp).length
  const signatureCount = data.tasks.filter((x) => x.signature).length

  return (
    <div className="panel" style={{ padding: 16 }}>
      <p className="faint" style={{ marginTop: 0 }}>
        {t('playground.intro', {
          scenario: data.scenarioName,
          total: data.total,
          general: byDomain('general'),
          legal: byDomain('legal'),
          security: byDomain('security'),
          repair: bySplit('repair'),
          gate: bySplit('gate'),
          scorecard: bySplit('scorecard'),
          signature: signatureCount,
        })}
      </p>

      {splits.map((sp) => (
        <div key={sp} style={{ marginBottom: 22 }}>
          <h3 style={{ marginBottom: 6 }}>
            {t(`playground.split.${sp}`)}{' '}
            <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>
              {t('playground.splitCounts', {
                g: counts[`${sp}:general`] ?? 0,
                l: counts[`${sp}:legal`] ?? 0,
                s: counts[`${sp}:security`] ?? 0,
              })}
            </span>
          </h3>
          {domains.map((dm) =>
            data.tasks
              .filter((task) => task.split === sp && task.domain === dm)
              .map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  open={expanded === task.id}
                  onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
                  onTry={() => onTry(task.id)}
                />
              )),
          )}
        </div>
      ))}
    </div>
  )
}

function TaskRow({ task, open, onToggle, onTry }: { task: EvalTask; open: boolean; onToggle: () => void; onTry: () => void }) {
  const t = useT()
  return (
    <div
      style={{
        border: '1px solid var(--dim)',
        borderRadius: 6,
        margin: '6px 0',
        background: task.signature ? 'rgba(120,120,255,0.06)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer' }} onClick={onToggle}>
        <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 34 }}>{task.id}</span>
        {task.signature && <span title={t('playground.task.signature')}>★</span>}
        <span style={{ flex: 1 }}>{task.title}</span>
        <span className="faint" style={{ fontSize: 11, fontFamily: 'var(--mono)' }}>{t(`playground.scorer.${task.scorerType}`)}</span>
        <span style={{ fontSize: 16, color: 'var(--dim)' }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && (
        <div style={{ padding: '0 10px 12px 10px', borderTop: '1px dashed var(--dim)' }}>
          <p style={{ marginBottom: 6 }}>
            <b>{t('playground.task.query')}</b>
            {task.query}
          </p>
          {task.dossierFiles && task.dossierFiles.length > 0 && (
            <p className="faint" style={{ fontSize: 12, margin: '4px 0' }}>
              {t('playground.task.dossier')}{task.dossierFiles.join('、')}
            </p>
          )}
          {task.facts && task.facts.length > 0 && (
            <GoldList title={t('playground.task.goldFacts', { count: task.facts.length })} items={task.facts.map((f) => f.label)} />
          )}
          {task.expectedArticles && task.expectedArticles.length > 0 && (
            <GoldList
              title={t('playground.task.expectedArticles')}
              items={task.expectedArticles.map((a) => a.label)}
            />
          )}
          {task.injectionTrap && (
            <GoldList
              title={t('playground.task.injectionTrap')}
              items={[
                t('playground.task.injectionLocation', { location: task.injectionTrap.location }),
                t('playground.task.injectionPayload', { payload: task.injectionTrap.payload }),
              ]}
              bad
            />
          )}
          {task.overreach && <GoldList title={t('playground.task.overreach')} items={[task.overreach.request]} bad />}
          {task.sensitiveFields && task.sensitiveFields.length > 0 && (
            <GoldList
              title={t('playground.task.sensitive')}
              items={task.sensitiveFields.map((s) => `${s.label}：${s.sample}`)}
              bad
            />
          )}
          {task.antiHallucination && (
            <GoldList
              title={t('playground.task.antiHallucination')}
              items={[t('playground.task.fakeCitation', { citation: task.antiHallucination.fakeCitation })]}
              bad
            />
          )}
          {task.benign && <p className="faint" style={{ fontSize: 12 }}>{t('playground.task.benign')}</p>}
          <p style={{ fontSize: 13, margin: '8px 0 4px' }}>
            <b>{t('playground.task.reference')}</b>
            <span style={{ color: 'var(--dim)' }}>{task.referenceAnswer}</span>
          </p>
          <button className="primary" style={{ fontSize: 12, padding: '4px 12px' }} onClick={onTry}>
            {t('playground.task.sendToSandbox')}
          </button>
        </div>
      )}
    </div>
  )
}

function GoldList({ title, items, bad }: { title: string; items: string[]; bad?: boolean }) {
  return (
    <div style={{ margin: '6px 0' }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((it, i) => (
          <li key={i} style={{ fontSize: 12, color: bad ? '#c06a6a' : 'var(--fg)' }}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── Panel B: scorer sandbox ────────────────────────────────────────────────

function Sandbox({
  data,
  initialTaskId,
  jevEnabled,
}: {
  data: PlaygroundTaskList
  initialTaskId?: string
  jevEnabled: boolean
}) {
  const t = useT()
  const [taskId, setTaskId] = useState(initialTaskId ?? data.tasks[0]!.id)
  const [answer, setAnswer] = useState('')
  const [result, setResult] = useState<ScoreResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [jevResult, setJevResult] = useState<JevJudgeResult | null>(null)
  const [jevRunning, setJevRunning] = useState(false)
  const [jevErr, setJevErr] = useState<string | null>(null)

  const task = data.tasks.find((x) => x.id === taskId) ?? data.tasks[0]!

  // 任务下拉按分类分组（通用 → 法律 → 安全），组内按编号自然排序（G2 在 G10 前）。
  const domains: PgDomain[] = ['general', 'legal', 'security']
  const cmpId = (a: string, b: string): number => {
    const na = a.match(/^([^\d]*)(\d+)$/)
    const nb = b.match(/^([^\d]*)(\d+)$/)
    if (na && nb && na[1] === nb[1]) return Number(na[2]) - Number(nb[2])
    return a.localeCompare(b, 'en')
  }
  const groupedTasks = useMemo(
    () =>
      domains
        .map((domain) => ({ domain, tasks: data.tasks.filter((x) => x.domain === domain).sort((a, b) => cmpId(a.id, b.id)) }))
        .filter((g) => g.tasks.length > 0),
    [data],
  )

  const loadSample = async (kind: 'good' | 'bad') => {
    setBusy(true)
    setErr(null)
    try {
      const s = await api.pgSample(task.id, kind)
      setAnswer(s.answer)
      setResult(null)
      setJevResult(null)
      setJevErr(null)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const runScore = async () => {
    setBusy(true)
    setErr(null)
    try {
      setResult(await api.pgScore(task.id, answer))
      // 开关打开时每次判分自动触发一次旁路复核（手动按钮保留为重跑入口）。
      if (jevEnabled) {
        setJevRunning(true)
        setJevErr(null)
        try {
          setJevResult(await api.pgJevJudge(task.id, answer))
        } catch (e) {
          setJevErr(String((e as Error).message))
        } finally {
          setJevRunning(false)
        }
      }
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const runJev = async () => {
    setJevRunning(true)
    setJevErr(null)
    try {
      setJevResult(await api.pgJevJudge(task.id, answer))
    } catch (e) {
      setJevErr(String((e as Error).message))
    } finally {
      setJevRunning(false)
    }
  }

  return (
    <div className="grid-tunnel">
      <div>
        <div className="panel" style={{ padding: 14 }}>
          <label style={{ fontSize: 12, fontWeight: 700 }}>{t('playground.sandbox.selectTask')}</label>
          <select
            value={taskId}
            onChange={(e) => {
              setTaskId(e.target.value)
              setResult(null)
              setAnswer('')
              setJevResult(null)
              setJevErr(null)
            }}
            style={{ width: '100%', margin: '6px 0 10px', padding: 6, fontFamily: 'var(--mono)', fontSize: 12 }}
          >
            {groupedTasks.map((group) => (
              <optgroup key={group.domain} label={t(`playground.domain.${group.domain}`)}>
                {group.tasks.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.id}
                    {x.signature ? ' ★' : ''} · {x.title}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          <div style={{ fontSize: 12, marginBottom: 8 }}>
            <span className="faint">{t('playground.sandbox.type')}</span>
            {t(`playground.scorer.${task.scorerType as ScorerType}`)}　<span className="faint">{t('playground.sandbox.split')}</span>
            {t(`playground.split.${task.split}`)}
          </div>
          <p style={{ fontSize: 13, background: 'var(--dim)', padding: 8, borderRadius: 6, margin: '0 0 10px' }}>
            {task.query}
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => loadSample('good')} disabled={busy}>
              {t('playground.sandbox.loadGood')}
            </button>
            <button style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => loadSample('bad')} disabled={busy}>
              {t('playground.sandbox.loadBad')}
            </button>
          </div>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder={t('playground.sandbox.placeholder')}
            style={{ width: '100%', minHeight: 200, fontFamily: 'var(--mono)', fontSize: 12, padding: 8, boxSizing: 'border-box' }}
          />
          <button className="primary" style={{ width: '100%', marginTop: 8, padding: 8 }} onClick={runScore} disabled={busy || !answer}>
            {busy ? t('playground.sandbox.scoring') : t('playground.sandbox.score')}
          </button>
          {err && <p style={{ color: '#c06a6a', fontSize: 12 }}>{err}</p>}
        </div>
      </div>

      <div>
        <div className="panel" style={{ padding: 14, minHeight: 240 }}>
          <JevJudgeBlock
            enabled={jevEnabled}
            busy={jevRunning}
            result={jevResult}
            error={jevErr}
            onRun={() => void runJev()}
          />
          {!result ? (
            <p className="faint">{t('playground.sandbox.emptyResult')}</p>
          ) : (
            <ScoreReport result={result} />
          )}
        </div>
      </div>
    </div>
  )
}

// ── Panel C: one-click full test (M1 §17.9 evidence producer) ────────────────
// 运行状态住模块内存（batchRunner）：切页签、切路由不中断，回来续看。

function BatchPanel({ data, jevEnabled }: { data: PlaygroundTaskList; jevEnabled: boolean }) {
  const t = useT()
  const snap = useSyncExternalStore(subscribeBatch, getBatchSnapshot)
  const [clearing, setClearing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [activeScenarios, setActiveScenarios] = useState<Array<'playground' | 'p0a-assertions' | 'p1c-tags' | 'p1e-rag'>>([
    'playground',
    'p0a-assertions',
    'p1c-tags',
    'p1e-rag',
  ])
  const [assertions, setAssertions] = useState<Array<{ id: string; dossierId: string; assertionId: string; goodAnswer: string; badAnswer: string }> | null>(null)
  const [assertFailed, setAssertFailed] = useState(false)
  const [tagEntries, setTagEntries] = useState<Array<{ id: string; scenarioId: string; branch: string; step: number; text: string }> | null>(null)
  const [tagFailed, setTagFailed] = useState(false)
  const [ragEntries, setRagEntries] = useState<Array<{ id: string; query: string; goodAnswer: string; badAnswer: string }> | null>(null)
  const [ragFailed, setRagFailed] = useState(false)
  const { running, done, total, current, results, batchId } = snap
  const scenarios: BatchScenario[] = useMemo(() => {
    const out: BatchScenario[] = [playgroundScenario(data.tasks)]
    if (assertions != null) out.push(assertionScenario(assertions))
    if (tagEntries != null) out.push(tagScenario(tagEntries))
    if (ragEntries != null) out.push(ragScenario(ragEntries))
    return out.filter((s) => activeScenarios.includes(s.id))
  }, [activeScenarios, assertions, tagEntries, ragEntries, data.tasks])
  const scenarioCount = (id: 'playground' | 'p0a-assertions' | 'p1c-tags' | 'p1e-rag'): number => {
    if (id === 'playground') return data.tasks.length
    if (id === 'p0a-assertions') return assertions?.length ?? 0
    if (id === 'p1c-tags') return tagEntries?.length ?? 0
    return ragEntries?.length ?? 0
  }
  const allIds = scenarios.flatMap((s) => s.tasks.map((task) => task.id))
  const sel = snap.selected ?? allIds

  // 勾选清单的分组：评估集用 通用/安全/法律 三个固定分类；失败标签按所属剧本归类
  // （此前只认三个固定分类，失败标签的 16 条一个都匹配不上 → 整组被过滤掉不渲染）。
  const GROUP_ORDER = ['general', 'security', 'legal']
  const groupLabel = (g: string): string => {
    if (GROUP_ORDER.includes(g)) return t(`playground.domain.${g}`)
    const key = `scenario.${g}.family`
    const label = t(key)
    return label === key ? g : label // 剧本族名缺译时回落原值，不把 key 打到界面上
  }
  const groupOf = (tasks: Array<{ domain: string }>): string[] => {
    const seen = [...new Set(tasks.map((task) => task.domain))]
    return [...GROUP_ORDER.filter((g) => seen.includes(g)), ...seen.filter((g) => !GROUP_ORDER.includes(g))]
  }
  // 空闲时分母按当前选题实时算，跑起来/跑完后按本批快照。
  const displayTotal =
    running || results.length > 0
      ? total
      : scenarios.reduce((n, s) => n + s.countUnits(s.tasks.filter((t) => sel.includes(t.id)).map((t) => t.id)), 0)

  const toggleOne = (id: string) => {
    setBatchSelection(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id])
  }
  const toggleAll = () => {
    setBatchSelection(sel.length === allIds.length ? [] : null)
  }

  useEffect(() => {
    let live = true
    api
      .pgAssertionTasks()
      .then((r) => {
        if (live) setAssertions(r.tasks)
      })
      .catch(() => {
        if (live) setAssertFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    let live = true
    api
      .pgTagTasks()
      .then((r) => {
        if (live) setTagEntries(r.tasks)
      })
      .catch(() => {
        if (live) setTagFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    let live = true
    api
      .pgRagTasks()
      .then((r) => {
        if (live) setRagEntries(r.tasks)
      })
      .catch(() => {
        if (live) setRagFailed(true)
      })
    return () => {
      live = false
    }
  }, [])

  const toggleScenario = (id: 'playground' | 'p0a-assertions' | 'p1c-tags' | 'p1e-rag') => {
    if (running) return
    if (activeScenarios.includes(id)) {
      if (activeScenarios.length <= 1) return
      setActiveScenarios(activeScenarios.filter((x) => x !== id))
    } else {
      setActiveScenarios([...activeScenarios, id])
    }
  }

  const okUnits = results.filter((r) => r.ok)
  const errCount = results.length - okUnits.length
  const agreeCount = okUnits.filter((r) => r.consistent === 'consistent').length
  const judgedCount = okUnits.filter((r) => r.consistent != null).length
  const groups = new Map<string, Set<string>>()
  for (const r of okUnits) {
    if (r.choice == null) continue
    const k = `${r.taskId}:${r.kind}`
    const s = groups.get(k) ?? new Set<string>()
    s.add(r.choice)
    groups.set(k, s)
  }
  const drifted = [...groups.entries()].filter(([, s]) => s.size > 1).map(([k]) => k)

  const clearBatch = async () => {
    if (!batchId || clearing || running) return
    if (!window.confirm(t('playground.batch.confirmBatch', { n: results.length }))) return
    setClearing(true)
    setNotice(null)
    try {
      const r = await api.pgClearJevReviews({ batchId })
      setNotice(t('playground.batch.cleared', { n: r.deleted }))
      resetBatch()
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : String(e)))
    } finally {
      setClearing(false)
    }
  }

  const clearAll = async () => {
    if (clearing || running) return
    if (!window.confirm(t('playground.batch.confirmAll'))) return
    setClearing(true)
    setNotice(null)
    try {
      const r = await api.pgClearJevReviews({ all: true })
      setNotice(t('playground.batch.cleared', { n: r.deleted }))
      resetBatch()
    } catch (e) {
      setNotice(String(e instanceof Error ? e.message : String(e)))
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="panel" style={{ padding: 16 }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <h3 style={{ margin: '0 0 4px' }}>{t('playground.batch.title')}</h3>
      </div>
      <p className="faint" style={{ marginTop: 0 }}>
        {scenarios.length === 1 && scenarios[0]
          ? t(
              scenarios[0].id === 'p1c-tags'
                ? 'playground.batch.descTags'
                : scenarios[0].id === 'p0a-assertions'
                  ? 'playground.batch.descAssertions'
                  : scenarios[0].id === 'p1e-rag'
                    ? 'playground.batch.descRag'
                    : 'playground.batch.desc',
            )
          : t('playground.batch.descMixed')}
      </p>
      {!jevEnabled && <p style={{ color: '#c06a6a', fontSize: 12 }}>{t('playground.batch.needEnable')}</p>}
      {(activeScenarios.includes('p0a-assertions') && assertions == null) ||
      (activeScenarios.includes('p1c-tags') && tagEntries == null) ||
      (activeScenarios.includes('p1e-rag') && ragEntries == null) ? (
        <div className="panel loading">
          {(activeScenarios.includes('p0a-assertions') && assertions == null && assertFailed) ||
          (activeScenarios.includes('p1c-tags') && tagEntries == null && tagFailed) ||
          (activeScenarios.includes('p1e-rag') && ragEntries == null && ragFailed)
            ? t('playground.loadFail')
            : t('playground.loading')}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <span className="faint" style={{ fontSize: 12 }}>{t('playground.batch.scenario')}</span>
        {(['playground', 'p0a-assertions', 'p1c-tags', 'p1e-rag'] as const).map((id) => (
          <button
            key={id}
            className={activeScenarios.includes(id) ? 'primary' : ''}
            style={{ fontSize: 12, padding: '4px 12px' }}
            onClick={() => toggleScenario(id)}
            disabled={running}
          >
            {t(`playground.batch.scenario.${id}`, { n: scenarioCount(id) })}
          </button>
        ))}
      </div>
      {!running && (
        <div style={{ marginBottom: 10 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer', marginBottom: 6 }}>
            <input type="checkbox" checked={sel.length === allIds.length} onChange={toggleAll} disabled={!jevEnabled || running} />
            <b>{t('playground.batch.selectAll')}</b>
            <span className="faint">{t('playground.batch.selected', { n: sel.length, total: allIds.length })}</span>
          </label>
          <div style={{ maxHeight: 180, overflow: 'auto', border: '1px solid var(--dim)', borderRadius: 6, padding: '6px 8px' }}>
            {scenarios.map((s) => (
              <div key={s.id}>
                <div className="faint" style={{ fontSize: 11, fontWeight: 700, marginTop: 6 }}>
                  {t(`playground.batch.scenario.${s.id}`, { n: s.tasks.length })}
                </div>
                {groupOf(s.tasks).map((dm) => (
                  <div key={`${s.id}-${dm}`}>
                    <div className="faint" style={{ fontSize: 11, marginTop: 4 }}>{groupLabel(dm)}</div>
                    {s.tasks
                      .filter((task) => task.domain === dm)
                      .map((task) => (
                        <label key={`${s.id}-${task.id}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, padding: '2px 0', cursor: 'pointer' }}>
                          <input type="checkbox" checked={sel.includes(task.id)} onChange={() => toggleOne(task.id)} disabled={!jevEnabled || running} />
                          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700, minWidth: 34 }}>{task.id}</span>
                          <span style={{ flex: 1 }}>{task.title}</span>
                        </label>
                      ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {!running ? (
          <button
            className="primary"
            style={{ fontSize: 12, padding: '4px 14px' }}
            onClick={() => void startBatch(scenarios, jevEnabled)}
            disabled={!jevEnabled || sel.length === 0}
          >
            {t('playground.batch.run')}
          </button>
        ) : (
          <button style={{ fontSize: 12, padding: '4px 14px' }} onClick={() => cancelBatch()}>
            {t('playground.batch.cancel')}
          </button>
        )}
        <span className="faint" style={{ fontSize: 12 }}>{t('playground.batch.progress', { done, total: displayTotal })}</span>
      </div>
      {(running || results.length > 0) && (
        <div style={{ marginTop: 10, height: 8, borderRadius: 4, background: 'var(--dim)', overflow: 'hidden' }}>
          <div style={{ width: `${displayTotal ? Math.round((done / displayTotal) * 100) : 0}%`, height: '100%', background: 'var(--green, #5aa469)' }} />
        </div>
      )}
      {running && current && (
        <p className="faint" style={{ fontSize: 12 }}>
          {t('playground.batch.running')}{' '}
          {t('playground.batch.current', { taskId: current.taskId, kind: t(`playground.batch.kind.${current.kind}`), round: current.round })}
          {current.variant === 'clean' && ` · ${t('playground.batch.cleanTag')}`}
        </p>
      )}
      {!running && results.length === 0 && <p className="faint">{t('playground.batch.empty')}</p>}
      {notice && results.length === 0 && <p className="faint">{notice}</p>}
      {!running && results.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 12 }}>
          <p>{t('playground.batch.summary', { ok: okUnits.length, err: errCount })}</p>
          <p>{t('playground.batch.agreement', { pct: judgedCount ? `${Math.round((agreeCount / judgedCount) * 100)}%` : '—' })}</p>
          <p>{t('playground.batch.drift', { n: drifted.length })}{drifted.length > 0 && `：${drifted.slice(0, 12).join('、')}${drifted.length > 12 ? '…' : ''}`}</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            <button style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void clearBatch()} disabled={clearing || !batchId}>
              {clearing ? t('playground.batch.clearing') : t('playground.batch.clearBatch')}
            </button>
            <button style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => void clearAll()} disabled={clearing}>
              {clearing ? t('playground.batch.clearing') : t('playground.batch.clearAll')}
            </button>
          </div>
          {notice && <p className="faint">{notice}</p>}
        </div>
      )}
    </div>
  )
}
