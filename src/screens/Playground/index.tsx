import { Fragment, useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import { useT } from '../../i18n'
import type {
  PlaygroundTaskList,
  EvalTask,
  PgSplit,
  PgDomain,
} from '../../../shared/playground'
import LivePanel from './LivePanel'
import EvolutionPanel from './EvolutionPanel'

type Workspace = 'live' | 'evolve' | 'evalset'

export default function Playground() {
  const t = useT()
  const [tab, setTab] = useState<Workspace>('live')
  const [data, setData] = useState<PlaygroundTaskList | null>(null)
  const [failed, setFailed] = useState(false)

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

  const workspaces: Array<{ id: Workspace; label: string; hint: string }> = [
    { id: 'live', label: t('playground.workspace.evaluate'), hint: t('playground.workspace.evaluateHint') },
    { id: 'evolve', label: t('playground.workspace.evolve'), hint: t('playground.workspace.evolveHint') },
    { id: 'evalset', label: t('playground.workspace.evalset'), hint: t('playground.workspace.evalsetHint') },
  ]

  return (
    <div className="page">
      <div className="screen-head">
        <span className="no">{t('playground.eyebrow')}</span>
        <h1>{t('playground.title')}</h1>
        <span className="q">{t('playground.subtitle')}</span>
      </div>

      {data && (
        <div className="pg-scenario">
          <div className="pg-scenario-main">
            <span className="pg-scenario-name">{data.scenarioName}</span>
            <span className="pg-scenario-sub">{t('playground.scenario.sub')}</span>
          </div>
          <div className="pg-scenario-facts">
            <span className="pg-fact"><b>{data.total}</b>{t('playground.scenario.tasks')}</span>
            <span className="pg-fact">
              <b>{countOf(data.tasks, 'domain', 'general')} / {countOf(data.tasks, 'domain', 'legal')} / {countOf(data.tasks, 'domain', 'security')}</b>
              {t('playground.scenario.domains')}
            </span>
            <span className="pg-fact">
              <b>{countOf(data.tasks, 'split', 'repair')} / {countOf(data.tasks, 'split', 'gate')} / {countOf(data.tasks, 'split', 'scorecard')}</b>
              {t('playground.scenario.splits')}
            </span>
            <span className="pg-fact"><b>★ {data.tasks.filter((x) => x.signature).length}</b>{t('playground.scenario.signature')}</span>
          </div>
        </div>
      )}

      <div className="pg-workspace-nav" role="tablist" aria-label={t('playground.title')}>
        {workspaces.map((w) => (
          <button
            key={w.id}
            role="tab"
            aria-selected={tab === w.id}
            className={`pg-workspace-tab ${tab === w.id ? 'active' : ''}`}
            onClick={() => setTab(w.id)}
          >
            <span className="pg-workspace-label">{w.label}</span>
            <span className="pg-workspace-hint">{w.hint}</span>
          </button>
        ))}
      </div>

      {!data ? (
        <div className="panel loading">{failed ? t('playground.loadFail') : t('playground.loading')}</div>
      ) : tab === 'evalset' ? (
        <EvalSetPanel data={data} />
      ) : tab === 'live' ? (
        <LivePanel tasks={data.tasks} />
      ) : tab === 'evolve' ? (
        <EvolutionPanel onOpenEvaluate={() => setTab('live')} />
      ) : null}
    </div>
  )
}

function countOf<T extends 'domain' | 'split'>(tasks: EvalTask[], field: T, value: string): number {
  return tasks.filter((task) => String(task[field]) === value).length
}

// ── Panel A: the eval set ──────────────────────────────────────────────────

function EvalSetPanel({ data }: { data: PlaygroundTaskList }) {
  const t = useT()
  const splits: PgSplit[] = ['repair', 'gate', 'scorecard']
  const domains: PgDomain[] = ['general', 'legal', 'security']
  const [split, setSplit] = useState<PgSplit | 'all'>('all')
  const [domain, setDomain] = useState<PgDomain | 'all'>('all')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const splitCount = (sp: PgSplit) => data.tasks.filter((x) => x.split === sp).length
  const domainCount = (dm: PgDomain) => data.tasks.filter((x) => x.domain === dm).length
  const signatureCount = data.tasks.filter((x) => x.signature).length

  const rows = useMemo(() => {
    const splitRank = new Map(splits.map((s, i) => [s, i]))
    const domainRank = new Map(domains.map((d, i) => [d, i]))
    const q = search.trim().toLowerCase()
    return data.tasks
      .filter((task) => (split === 'all' || task.split === split) && (domain === 'all' || task.domain === domain))
      .filter((task) => !q || task.id.toLowerCase().includes(q) || task.title.toLowerCase().includes(q) || task.query.toLowerCase().includes(q))
      .sort((a, b) => {
        const sa = splitRank.get(a.split) ?? 9
        const sb = splitRank.get(b.split) ?? 9
        if (sa !== sb) return sa - sb
        const da = domainRank.get(a.domain) ?? 9
        const db = domainRank.get(b.domain) ?? 9
        if (da !== db) return da - db
        return a.id.localeCompare(b.id, 'en', { numeric: true })
      })
  }, [data, split, domain, search])

  return (
    <div className="pg-eval">
      <div className="pg-eval-stats">
        <div className="pg-stat-card pg-stat-total">
          <span className="pg-stat-label">{t('playground.eval.allTasks')}</span>
          <b>{data.total}</b>
          <span className="pg-stat-sub">{t('playground.eval.signatureCount', { count: signatureCount })}</span>
        </div>
        {splits.map((sp) => (
          <button
            key={sp}
            className={`pg-stat-card ${split === sp ? 'active' : ''}`}
            onClick={() => setSplit(split === sp ? 'all' : sp)}
          >
            <span className="pg-stat-label">{t(`playground.split.${sp}`)}</span>
            <b>{splitCount(sp)}</b>
            <span className="pg-stat-sub">
              {t('playground.eval.domainBreakdown', {
                g: data.tasks.filter((x) => x.split === sp && x.domain === 'general').length,
                l: data.tasks.filter((x) => x.split === sp && x.domain === 'legal').length,
                s: data.tasks.filter((x) => x.split === sp && x.domain === 'security').length,
              })}
            </span>
          </button>
        ))}
      </div>

      <div className="panel pg-eval-panel">
        <div className="pg-panel-head">
          <div>
            <h3>{t('playground.eval.title')}</h3>
            <p className="faint">{t('playground.eval.desc')}</p>
          </div>
          <span className="pg-count-pill">{t('playground.eval.shown', { shown: rows.length, total: data.total })}</span>
        </div>

        <div className="pg-filterbar">
          <div className="pg-filter-group">
            <span className="pg-filter-label">{t('playground.eval.split')}</span>
            <button className={`pg-chip ${split === 'all' ? 'active' : ''}`} onClick={() => setSplit('all')}>{t('playground.eval.all')}</button>
            {splits.map((sp) => (
              <button key={sp} className={`pg-chip ${split === sp ? 'active' : ''}`} onClick={() => setSplit(sp)}>
                {t(`playground.split.${sp}`)} <span className="pg-chip-count">{splitCount(sp)}</span>
              </button>
            ))}
          </div>
          <div className="pg-filter-group">
            <span className="pg-filter-label">{t('playground.eval.domain')}</span>
            <button className={`pg-chip ${domain === 'all' ? 'active' : ''}`} onClick={() => setDomain('all')}>{t('playground.eval.all')}</button>
            {domains.map((dm) => (
              <button key={dm} className={`pg-chip ${domain === dm ? 'active' : ''}`} onClick={() => setDomain(dm)}>
                {t(`playground.domain.${dm}`)} <span className="pg-chip-count">{domainCount(dm)}</span>
              </button>
            ))}
          </div>
          <input
            type="search"
            className="pg-eval-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('playground.eval.search')}
            aria-label={t('playground.eval.search')}
          />
        </div>

        <div className="pg-table-wrap">
          <table className="pg-task-table">
            <thead>
              <tr>
                <th>{t('playground.eval.colId')}</th>
                <th>{t('playground.eval.colTask')}</th>
                <th>{t('playground.eval.colDomain')}</th>
                <th>{t('playground.eval.colScorer')}</th>
                <th>{t('playground.eval.colSplit')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((task) => {
                const open = expanded === task.id
                return (
                  <Fragment key={task.id}>
                    <tr
                      className={`pg-task-row ${open ? 'open' : ''}`}
                      onClick={() => setExpanded(open ? null : task.id)}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setExpanded(open ? null : task.id)
                        }
                      }}
                    >
                      <td className="pg-task-id">{task.id}</td>
                      <td>
                        <span className="pg-task-title">
                          {task.signature && <span className="pg-star" title={t('playground.task.signature')}>★</span>}
                          {task.title}
                        </span>
                      </td>
                      <td><span className={`pg-domain-tag pg-domain-${task.domain}`}>{t(`playground.domain.${task.domain}`)}</span></td>
                      <td className="faint">{t(`playground.scorer.${task.scorerType}`)}</td>
                      <td className="faint">{t(`playground.split.${task.split}`)}</td>
                    </tr>
                    {open && (
                      <tr className="pg-task-detail-row">
                        <td colSpan={5}>
                          <div className="pg-task-detail">
                            <p><b>{t('playground.task.query')}</b>{task.query}</p>
                            {task.dossierFiles && task.dossierFiles.length > 0 && (
                              <p className="faint">{t('playground.task.dossier')}{task.dossierFiles.join(', ')}</p>
                            )}
                            {task.facts && task.facts.length > 0 && (
                              <GoldList title={t('playground.task.goldFacts', { count: task.facts.length })} items={task.facts.map((f) => f.label)} />
                            )}
                            {task.expectedArticles && task.expectedArticles.length > 0 && (
                              <GoldList title={t('playground.task.expectedArticles')} items={task.expectedArticles.map((a) => a.label)} />
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
                                items={task.sensitiveFields.map((s) => `${s.label}: ${s.sample}`)}
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
                            {task.benign && <p className="faint">{t('playground.task.benign')}</p>}
                            <p className="pg-reference"><b>{t('playground.task.reference')}</b>{task.referenceAnswer}</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <div className="pg-empty">{t('playground.eval.empty')}</div>}
      </div>
    </div>
  )
}

function GoldList({ title, items, bad }: { title: string; items: string[]; bad?: boolean }) {
  return (
    <div style={{ margin: '6px 0' }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {items.map((it, i) => (
          <li key={i} style={{ fontSize: 12, color: bad ? 'var(--red)' : 'var(--text)' }}>
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}
