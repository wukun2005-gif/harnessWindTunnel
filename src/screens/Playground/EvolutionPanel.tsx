import { useEffect, useMemo, useState } from 'react'
import { api } from '../../api'
import type {
  ApplyResult,
  ChangeCard,
  EvoCluster,
  EvoGeneration,
  EvoMutation,
  EvoRace,
  EvoRaceJob,
  EvoState,
} from '../../../shared/playground'
import { MAST_LABEL } from '../../../shared/mast'

const SLIDER_KEY = 'hwt-pg-autonomy'
/** §3.2 gate repeats per (task × config). Default 3 while temperature > 0. */
const REPEATS_KEY = 'hwt-pg-gate-repeats'
/** How many cards race side by side (design §7.2④ top-2). */
const TOPN_KEY = 'hwt-pg-race-topn'

/** USD with 4 significant decimals — gate runs cost fractions of a cent. */
function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '$0'
  if (v < 0.01) return `$${v.toFixed(4)}`
  return `$${v.toFixed(2)}`
}
const SURFACE_LABEL: Record<string, string> = {
  prompt: 'prompt',
  middleware: 'middleware',
  joint: 'joint',
}

const CARD_STATE_LABEL: Record<string, string> = {
  proposed: 'Awaiting falsification',
  screening: 'Falsification running',
  applied: 'Applied',
  falsified: 'Falsified',
  rejected: 'Rejected',
}

export default function EvolutionPanel() {
  const [state, setState] = useState<EvoState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [level, setLevel] = useState<number>(() => Number(localStorage.getItem(SLIDER_KEY) ?? '1'))
  const [repeats, setRepeats] = useState<number>(() => Number(localStorage.getItem(REPEATS_KEY) ?? '3'))
  const [topN, setTopN] = useState<number>(() => Number(localStorage.getItem(TOPN_KEY) ?? '2'))
  const [traceCard, setTraceCard] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(SLIDER_KEY, String(level))
  }, [level])
  useEffect(() => {
    localStorage.setItem(REPEATS_KEY, String(repeats))
  }, [repeats])
  useEffect(() => {
    localStorage.setItem(TOPN_KEY, String(topN))
  }, [topN])

  const refresh = () => api.pgEvoState().then((s) => setState(s)).catch((e) => setErr(String(e.message)))

  useEffect(() => {
    void refresh()
  }, [])

  // While any card is mid-falsification, a gate verify runs, or the auto loop
  // is active (all are multi-minute live re-runs), poll.
  const busyPolling = useMemo(() => {
    const screeningCard = (state?.cards ?? []).some((c) => c.status === 'screening')
    const gateRunning = (state?.mutations ?? []).some((m) => m.gateStatus === 'running')
    const autoRunning = state?.autoJob?.running === true
    const raceRunning = state?.raceJob?.running === true
    return screeningCard || gateRunning || autoRunning || raceRunning
  }, [state])
  useEffect(() => {
    if (!busyPolling) return
    const t = setInterval(() => {
      void api.pgEvoState().then((s) => setState(s)).catch(() => { /* keep polling */ })
    }, 4000)
    return () => clearInterval(t)
  }, [busyPolling])

  const analyze = async () => {
    setBusy('analyze')
    setErr(null)
    setNote(null)
    try {
      const r = await api.pgEvolve()
      setState(r.state)
      setNote(r.note ?? null)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const apply = async (card: ChangeCard, mode: 'manual' | 'auto') => {
    setBusy(card.cardId)
    setErr(null)
    setNote(null)
    try {
      const r: ApplyResult & { ok: boolean; state: EvoState; error?: string } = await api.pgApplyCard(card.cardId, {
        mode,
        autonomyLevel: level,
      })
      setState(r.state)
      if (!r.ok && r.error) setErr(r.error)
      if (r.started) setNote('Falsification re-runs started in the background (about 2–6 minutes); the result refreshes automatically.')
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const autoEvolve = async () => {
    if (!window.confirm('Continuous self-evolution re-runs several generations for real (minutes and real tokens per generation). It stops at a hard-gate / out-of-table card, or after 2 consecutive generations with no positive lift. Continue?')) return
    setBusy('auto')
    setErr(null)
    try {
      const r = await api.pgAutoEvolve(level)
      setState(r.state)
      if (!r.ok && r.error) setErr(r.error)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const gateVerify = async (commitId: string) => {
    setBusy(commitId)
    setErr(null)
    try {
      const r = await api.pgGateVerify(commitId, { repeats })
      setState(r.state)
      if (!r.ok && r.error) setErr(r.error)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const race = async () => {
    if (!window.confirm(
      `Race the top-${topN} candidates side by side: screen them on the failed repair subset, then re-run the 15-task held-out gate at gate×${repeats} (${topN} × 15 × ${repeats} × 2 real executions), and finally pick on the (success ↑ / cost ↓) Pareto frontier. This takes a while and spends real tokens. Continue?`,
    )) return
    setBusy('race')
    setErr(null)
    try {
      const r = await api.pgRace({ autonomyLevel: level, topN, repeats })
      setState(r.state)
      if (!r.ok && r.error) setErr(r.error)
      else setNote('Top-N race started in the background; the result refreshes automatically.')
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const rollback = async (g: EvoGeneration) => {
    if (!window.confirm(`Roll back to "${g.label}"? The current version is replaced (history is kept).`)) return
    setBusy(g.generationId)
    try {
      const r = await api.pgRollback(g.generationId)
      setState(r.state)
    } catch (e) {
      setErr(String((e as Error).message))
    } finally {
      setBusy(null)
    }
  }

  const cardsByCluster = useMemo(() => {
    const m = new Map<string, ChangeCard[]>()
    for (const c of state?.cards ?? []) {
      const arr = m.get(c.clusterId) ?? []
      arr.push(c)
      m.set(c.clusterId, arr)
    }
    return m
  }, [state])

  const mutationByCard = useMemo(() => {
    const m = new Map<string, EvoMutation>()
    for (const mu of state?.mutations ?? []) m.set(mu.cardId, mu)
    return m
  }, [state])

  return (
    <div className="pg-panel">
      <div className="pg-evo-head">
        <div className="pg-evo-title">
          <h3 style={{ margin: 0 }}>PRISM self-evolution loop</h3>
          <span className="faint">
            Deterministic clustering → edit-surface routing → LLM proposes inside the routed surface → real re-run falsification → approval gate → immutable version tree
          </span>
        </div>
        <div className="pg-evo-controls">
          <label className="pg-slider">
            Autonomy
            <select value={level} onChange={(e) => setLevel(Number(e.target.value))}>
              <option value={0}>0 — all manual</option>
              <option value={1}>1 — conditional auto</option>
              <option value={2}>2 — fully auto</option>
            </select>
          </label>
          <label className="pg-slider">
            Gate repeats
            <select value={repeats} onChange={(e) => setRepeats(Number(e.target.value))} title="Design §3.2: how many times each gate task runs per config (baseline and candidate share a seed inside a repeat, a new seed across repeats)">
              <option value={1}>×1 (suggested at temperature 0)</option>
              <option value={2}>×2</option>
              <option value={3}>×3 (default, temperature &gt; 0)</option>
              <option value={5}>×5</option>
            </select>
          </label>
          <button className="primary" onClick={() => void analyze()} disabled={busy === 'analyze' || state?.autoJob?.running}>
            {busy === 'analyze' ? 'Attributing…' : 'Cluster failed runs and propose change cards'}
          </button>
          <button onClick={() => void race()} disabled={busy === 'race' || state?.raceJob?.running || state?.autoJob?.running}>
            {state?.raceJob?.running ? 'Race running…' : `top-${topN} race (Pareto)`}
          </button>
          <button onClick={() => void autoEvolve()} disabled={busy === 'auto' || state?.autoJob?.running || level === 0}>
            {state?.autoJob?.running ? 'Self-evolution running…' : 'Continuous self-evolution (auto by slider)'}
          </button>
          <label className="pg-slider" title="How many candidate cards enter the gate side by side">
            Race width
            <select value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
              <option value={2}>2 (design default)</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
            </select>
          </label>
        </div>
      </div>
      {state?.autoJob && (
        <div className={`pg-autojob ${state.autoJob.running ? 'pg-autojob-run' : 'pg-autojob-done'}`}>
          <b>{state.autoJob.running ? 'Self-evolution running: ' : 'Self-evolution finished: '}</b>{state.autoJob.phase}
          {state.autoJob.generationsApplied > 0 && ` (${state.autoJob.generationsApplied} generations applied)`}
          {state.autoJob.stopReason && <span className="pg-autojob-stop"> | {state.autoJob.stopReason}</span>}
          {state.autoJob.lastError && <span className="pg-err"> | {state.autoJob.lastError}</span>}
        </div>
      )}
      <RacePanel
        job={state?.raceJob ?? null}
        cards={state?.cards ?? []}
        onApply={apply}
      />
      <p className="faint pg-evo-note">
        Hard guardrails: out-of-table candidates and security/legal hard-gate seams (permissions, globalPolicy,
        sandbox, authority-mcp, citation-audit) always require a human at any autonomy level; the scorecard is
        invisible to evolution; each generation changes exactly one seam.
      </p>
      {note && <p className="pg-note">{note}</p>}
      {err && <p className="pg-err">{err}</p>}

      {!state || state.clusters.length === 0 ? (
        <div className="pg-empty">
          No failure clusters yet. Run the flagship questions under the baseline on the Run tab until failures
          exist, then come back here to attribute them.
        </div>
      ) : (
        <div className="pg-evo-body">
          <div className="pg-evo-clusters">
            {state.clusters.map((cluster) => (
              <ClusterBlock
                key={cluster.clusterId}
                cluster={cluster}
                cards={cardsByCluster.get(cluster.clusterId) ?? []}
                mutationByCard={mutationByCard}
                busy={busy}
                onApply={apply}
                onGate={gateVerify}
                traceCard={traceCard}
                setTraceCard={setTraceCard}
              />
            ))}
          </div>
          <VersionTree state={state} busy={busy} onRollback={rollback} />
        </div>
      )}
    </div>
  )
}

function ClusterBlock({
  cluster,
  cards,
  mutationByCard,
  busy,
  onApply,
  onGate,
  traceCard,
  setTraceCard,
}: {
  cluster: EvoCluster
  cards: ChangeCard[]
  mutationByCard: Map<string, EvoMutation>
  busy: string | null
  onApply: (card: ChangeCard, mode: 'manual' | 'auto') => void
  onGate: (commitId: string) => void
  traceCard: string | null
  setTraceCard: (id: string | null) => void
}) {
  const lastRoute = cluster.routeHistory[cluster.routeHistory.length - 1]
  return (
    <div className="pg-cluster">
      <div className="pg-cluster-head">
        <span className="pg-cluster-tag">{MAST_LABEL[cluster.tag] ?? cluster.tag}</span>
        <span className="pg-cluster-count">{cluster.count} run</span>
        <span className={`pg-cluster-status pg-cluster-${cluster.status}`}>{cluster.status}</span>
        <span className="faint pg-cluster-domain">{cluster.domain}</span>
      </div>
      <p className="pg-cluster-summary">{cluster.summary}</p>
      <p className="faint pg-cluster-seam">Attributed seam: {cluster.seam}</p>
      <p className="faint pg-cluster-route">Route: {lastRoute?.surface} · {lastRoute?.reason}</p>
      {cluster.criticalSteps.length > 0 && (
        <p className="faint pg-cluster-steps">Critical failure steps: {cluster.criticalSteps.join(', ')}</p>
      )}

      {cards.length === 0 ? (
        <p className="faint">No change card (this cluster may need human judgement).</p>
      ) : (
        cards.map((card) => (
          <CardBlock
            key={card.cardId}
            card={card}
            mutation={mutationByCard.get(card.cardId) ?? null}
            busy={busy === card.cardId || card.status === 'screening' || mutationByCard.get(card.cardId)?.gateStatus === 'running'}
            onApply={onApply}
            onGate={onGate}
            traceOpen={traceCard === card.cardId}
            toggleTrace={() => setTraceCard(traceCard === card.cardId ? null : card.cardId)}
          />
        ))
      )}
    </div>
  )
}

function CardBlock({
  card,
  mutation,
  busy,
  onApply,
  onGate,
  traceOpen,
  toggleTrace,
}: {
  card: ChangeCard
  mutation: EvoMutation | null
  busy: boolean
  onApply: (card: ChangeCard, mode: 'manual' | 'auto') => void
  onGate: (commitId: string) => void
  traceOpen: boolean
  toggleTrace: () => void
}) {
  const f = mutation?.falsification ?? null
  const gate = mutation?.gate ?? null
  const gateStatus = mutation?.gateStatus ?? 'idle'
  const hardHuman = card.hardGate || !card.inTable || card.verdict === 'needs-human'
  return (
    <div className={`pg-card pg-card-${card.status} ${card.hardGate ? 'pg-card-hard' : ''}`}>
      <div className="pg-card-head">
        <span className={`pg-surface pg-surface-${card.surface}`}>{SURFACE_LABEL[card.surface]}</span>
        <span className="pg-card-title">{card.title}</span>
        <span className={`pg-card-status pg-card-state-${card.status}`}>{CARD_STATE_LABEL[card.status] ?? card.status}</span>
      </div>
      {card.status === 'screening' && (
        <p className="pg-card-screening">Falsifying with real re-runs: re-executing the failed tasks and the regression guards, paired one by one — this takes minutes…</p>
      )}
      <p className="pg-card-nl">{card.nl}</p>
      <div className="pg-card-badges">
        <span className={`pg-badge ${card.inTable ? 'pg-badge-intable' : 'pg-badge-outtable'}`}>
          {card.inTable ? 'In-table candidate' : 'Out-of-table combination · human review required'}
        </span>
        {card.hardGate && <span className="pg-badge pg-badge-hard">Security/legal hard gate · always human-approved</span>}
        <span className="pg-badge pg-badge-src">{card.proposalSource === 'llm' ? 'LLM proposal' : 'Deterministic template'}</span>
        {card.predictedGainPp != null && (
          <span className="pg-badge pg-badge-pred">Predicted ceiling ≈ +{card.predictedGainPp}pp</span>
        )}
      </div>

      {(card.promptDiff || card.middlewareDiff || card.mountDiff) && (
        <div className="pg-card-diff">
          {card.promptDiff?.guideStyle && (
            <div><b>guides: </b><code>{card.promptDiff.guideStyle}</code></div>
          )}
          {card.promptDiff?.guides && (
            <div className="pg-card-guide">
              <b>Guidance text: </b>{card.promptDiff.guides}
            </div>
          )}
          {card.middlewareDiff && (
            <div><b>DSL: </b><code>{JSON.stringify(card.middlewareDiff)}</code></div>
          )}
          {card.mountDiff && (
            <div><b>mounts: </b><code>{JSON.stringify(card.mountDiff)}</code></div>
          )}
        </div>
      )}

      {card.llmOutput && (
        <button className="pg-trace-toggle" onClick={toggleTrace}>
          {traceOpen ? 'Hide the LLM proposal trace' : 'Show the LLM proposal trace (prompt / raw output)'}
        </button>
      )}
      {traceOpen && card.llmOutput && (
        <div className="pg-card-trace">
          <details open>
            <summary>Proposal prompt</summary>
            <pre>{card.llmPrompt}</pre>
          </details>
          <details open>
            <summary>Raw model output</summary>
            <pre>{card.llmOutput}</pre>
          </details>
        </div>
      )}

      {f && <FalsificationView f={f} />}
      {mutation && <GateView gate={gate} status={gateStatus} />}

      <div className="pg-card-actions">
        <button className="primary" onClick={() => void onApply(card, 'manual')} disabled={busy || card.status === 'applied' || card.verdict === 'needs-human'}>
          {busy ? 'Falsifying with real re-runs…' : 'Approve and apply (re-run verification)'}
        </button>
        {!hardHuman && (
          <button onClick={() => void onApply(card, 'auto')} disabled={busy || card.status === 'applied'}>
            Apply automatically per slider
          </button>
        )}
        {mutation && (
          <button onClick={() => void onGate(mutation.commitId)} disabled={busy || gateStatus === 'running'}>
            {gateStatus === 'running' ? 'Full gate-15 verification running…' : 'Full held-out verification on the gate-15 set'}
          </button>
        )}
        {card.verdict === 'needs-human' && (
          <span className="faint">This candidate never auto-applies; it is for human judgement only.</span>
        )}
      </div>
    </div>
  )
}

/**
 * §7.2④ side-by-side race: shows every candidate that entered the race, what
 * it scored on the held-out gate set, what it cost, whether it sits on the
 * (success ↑, cost ↓) frontier, and which one won. Without this the "Pareto 择优"
 * claim would be an uncheckable tie-break.
 */
function RacePanel({
  job,
  cards,
  onApply,
}: {
  job: EvoRaceJob | null
  cards: ChangeCard[]
  onApply: (card: ChangeCard, mode: 'manual' | 'auto') => void
}) {
  if (!job) return null
  const race: EvoRace | null = job.race
  const titleById = new Map(cards.map((c) => [c.cardId, c]))
  const winner = race?.winnerCardId ? titleById.get(race.winnerCardId) ?? null : null
  return (
    <div className={`pg-race ${job.running ? 'pg-race-run' : 'pg-race-done'}`}>
      <div className="pg-race-head">
        <b>{job.running ? 'Top-N race running: ' : 'Top-N race result: '}</b>
        {job.phase}
        {race && ` (top-${race.topN} · gate×${race.repeats} · screened ${race.screened} · gated ${race.gated})`}
        {job.lastError && <span className="pg-err"> | {job.lastError}</span>}
      </div>
      {race?.note && <div className="pg-race-note">{race.note}</div>}
      {race && race.entries.length > 0 && (
        <table className="pg-race-table">
          <thead>
            <tr>
              <th>Candidate</th>
              <th>Surface</th>
              <th>Gate success</th>
              <th>Gate lift</th>
              <th>Regressed</th>
              <th>Cost</th>
              <th>Pareto</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {race.entries.map((e) => {
              const isWinner = e.cardId === race.winnerCardId
              return (
                <tr key={e.cardId} className={isWinner ? 'pg-race-win' : ''}>
                  <td className="pg-race-title">{e.title}</td>
                  <td>{e.surface}</td>
                  <td>
                    {e.dropped === null
                      ? `${e.baselinePassPp}% → ${e.candidatePassPp}%`
                      : '—'}
                  </td>
                  <td>{e.dropped === null ? `${e.gateLiftPp >= 0 ? '+' : ''}${e.gateLiftPp}pp` : '—'}</td>
                  <td>{e.dropped === null ? e.regressed : '—'}</td>
                  <td>
                    {e.dropped === null
                      ? e.costAxis === 'usd'
                        ? fmtUsd(e.avgCostUsd)
                        : `${Math.round(e.cost)} tok${e.costAxis === 'token' ? ' (proxy)' : ''}`
                      : '—'}
                  </td>
                  <td>{e.onFrontier ? 'Frontier' : e.dropped === null ? 'Dominated' : '—'}</td>
                  <td className="pg-race-verdict">
                    {isWinner ? 'Pareto winner' : e.dropped ?? ''}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      {race && race.awaitingHuman && winner && (
        <div className="pg-race-actions">
          <span>A winner was picked, but §7.5 forbids auto-applying it:</span>
          <button
            className="primary"
            onClick={() => void onApply(winner, 'manual')}
            disabled={winner.status === 'screening' || winner.status === 'applied'}
          >
            Approve and apply the winning card
          </button>
        </div>
      )}
    </div>
  )
}

function GateView({ gate, status }: { gate: NonNullable<EvoMutation['gate']> | null; status: string }) {
  if (status === 'idle') return null
  if (status === 'running') {
    return <div className="pg-falsify pg-falsify-running">Re-running the 15 held-out gate tasks at ×N repeats for both baseline and candidate (about 30×N real executions)…</div>
  }
  if (!gate) return <div className="pg-falsify pg-falsify-bad">Gate verification failed (execution error).</div>
  const ok = status === 'passed'
  const sample = gate.gateTaskIds.length * gate.repeats
  return (
    <div className={`pg-falsify ${ok ? 'pg-falsify-good' : 'pg-falsify-bad'}`}>
      <div>
        <b>Full gate-15 verification: </b>
        success {gate.baselinePassPp}% → {gate.candidatePassPp}% (gate lift {gate.gateLiftPp}pp)
        regressed {gate.regressed.length} · fixed {gate.fixed.length}
      </div>
      <div className="faint">
        repeats ×{gate.repeats} ({sample} paired samples) · avg tokens {gate.avgTokens ?? '—'} · avg cost {fmtUsd(gate.avgCostUsd)} · avg time {gate.avgLatencyMs ? `${Math.round(gate.avgLatencyMs / 1000)}s` : '—'}
      </div>
      {gate.regressed.length > 0 && <div className="pg-falsify-regress">hold-out regressed: {gate.regressed.join(', ')}</div>}
      {gate.fixed.length > 0 && <div className="pg-falsify-rescue">hold-out fixed: {gate.fixed.join(', ')}</div>}
    </div>
  )
}

function FalsificationView({ f }: { f: NonNullable<EvoMutation['falsification']> }) {
  const ci = f.relLift95 == null ? 'sample too small for a 95% lower bound' : `RelLift₉₅ lower bound ≈ ${f.relLift95}pp`
  return (
    <div className={`pg-falsify ${f.regressed.length > 0 ? 'pg-falsify-bad' : f.rescued.length > 0 ? 'pg-falsify-good' : ''}`}>
      <div>
        <b>Falsification by real re-runs: </b>
        rescued {f.rescued.length} · regressed {f.regressed.length} · still failed {f.stillFailed.length} · net lift {f.netLiftPp}pp
      </div>
      <div className="faint">
        {ci} · avg tokens {f.avgTokens ?? '—'} · avg cost {fmtUsd(f.avgCostUsd)} · avg time {f.avgLatencyMs ? `${Math.round(f.avgLatencyMs / 1000)}s` : '—'}
      </div>
      {f.rescued.length > 0 && <div className="pg-falsify-rescue">rescued: {f.rescued.join(', ')}</div>}
      {f.regressed.length > 0 && <div className="pg-falsify-regress">regressed: {f.regressed.join(', ')}</div>}
    </div>
  )
}

function VersionTree({
  state,
  busy,
  onRollback,
}: {
  state: EvoState
  busy: string | null
  onRollback: (g: EvoGeneration) => void
}) {
  const gens = [...state.generations].reverse()
  return (
    <div className="pg-evo-tree">
      <h4>Immutable version tree</h4>
      {gens.length === 0 ? (
        <p className="faint">No change applied yet. The first card that passes falsification creates a version here.</p>
      ) : (
        <ul className="pg-gen-list">
          {gens.map((g) => (
            <li key={g.generationId} className={`pg-gen ${g.generationId === state.currentGenerationId ? 'pg-gen-current' : ''}`}>
              <div className="pg-gen-row">
                <span className="pg-gen-label">{g.generationId === state.currentGenerationId ? '● ' : '○ '}{g.label}</span>
                <span className="faint pg-gen-meta">{g.source} · {g.fingerprint.slice(0, 10)}</span>
              </div>
              {g.generationId !== state.currentGenerationId && (
                <button disabled={busy != null} onClick={() => void onRollback(g)} className="pg-rollback">
                  Roll back to this version
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
