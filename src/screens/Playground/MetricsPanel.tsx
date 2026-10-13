import type { LiveMetrics, RunSummary } from '../../../shared/playground'
import {
  failureByConfig,
  modelByHarness,
  paretoAxis,
  paretoCost,
  paretoFrontier,
  paretoPoints,
} from './metricsMatrix'

interface Props {
  runs: RunSummary[]
  metrics: LiveMetrics | null
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`)

/** USD with enough precision for sub-cent agent runs. */
function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '$0'
  return v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`
}

/** Quality-cost Pareto scatter (x = cost, y = success rate). Pure SVG. */
function ParetoChart({ runs }: { runs: RunSummary[] }) {
  const points = paretoPoints(runs)
  const axis = paretoAxis(points)
  // The frontier walk assumes ascending cost, so sort on the drawn axis.
  points.sort((a, b) => paretoCost(a, axis) - paretoCost(b, axis))
  const front = paretoFrontier(points)
  if (points.length === 0) return <div className="pg-empty">No runs to plot yet.</div>

  const W = 440
  const H = 250
  const pad = { l: 44, r: 14, t: 16, b: 34 }
  const maxX = Math.max(...points.map((p) => paretoCost(p, axis)), axis === 'usd' ? 0.0001 : 1)
  const x = (v: number) => pad.l + (v / maxX) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - v) * (H - pad.t - pad.b)
  const axisLabel = axis === 'usd' ? 'Average cost, USD (provider × model price table)' : 'Average tokens (no price table for these models — tokens as a cost proxy)'
  const tick = (v: number) => (axis === 'usd' ? `$${v.toFixed(4)}` : fmt(v))

  return (
    <div className="pg-chart">
      <svg width={W} height={H} className="pg-svg">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="pg-grid-line" />
            <text x={pad.l - 6} y={y(v) + 3} className="pg-axis-txt" textAnchor="end">
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        <line x1={pad.l} x2={pad.l} y1={pad.t} y2={H - pad.b} className="pg-axis" />
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="pg-axis" />
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <text key={f} x={x(maxX * f)} y={H - 20} className="pg-axis-txt" textAnchor="middle">
            {tick(maxX * f)}
          </text>
        ))}
        <text x={W / 2} y={H - 6} className="pg-axis-title" textAnchor="middle">
          {axisLabel}
        </text>
        {points.map((p) => (
          <g key={p.label}>
            <circle
              cx={x(paretoCost(p, axis))}
              cy={y(p.successRate)}
              r={7 + Math.min(10, p.avgLatency / 1000)}
              className={front.has(p.label) ? 'pg-pareto-dot front' : 'pg-pareto-dot'}
            />
            <text
              x={x(paretoCost(p, axis))}
              y={y(p.successRate) - 12}
              className="pg-dot-label"
              textAnchor="middle"
            >
              {p.label}
            </text>
          </g>
        ))}
      </svg>
      <div className="pg-legend">
        <span className="pg-legend-dot front" /> Pareto frontier
        <span className="pg-legend-dot" /> Dominated
        <span className="pg-legend-note">Bubble radius ≈ average latency</span>
      </div>
    </div>
  )
}

/**
 * Live metrics area (design §10 M3): aggregate table, failure-mode × config
 * heatmap, quality-cost Pareto, model × harness cross. Runs are already
 * source-filtered by the parent.
 */
export function MetricsPanel({ runs, metrics }: Props) {
  const fail = failureByConfig(runs)
  const cross = modelByHarness(runs)

  const heatColor = (cell: { count: number; total: number }) => {
    if (cell.count === 0) return 'rgba(220,38,38,0.02)'
    const ratio = cell.count / Math.max(cell.total, 1)
    return `rgba(220,38,38,${(0.12 + ratio * 0.55).toFixed(2)})`
  }
  const rateColor = (rate: number | null) => {
    if (rate === null) return 'transparent'
    if (rate >= 0.7) return 'rgba(5,150,105,0.18)'
    if (rate >= 0.4) return 'rgba(180,83,9,0.16)'
    return 'rgba(220,38,38,0.16)'
  }

  return (
    <div className="pg-metrics">
      <div className="pg-metrics-head">
        <span>Metrics</span>
        <span className="pg-metrics-note">{runs.length} run(s) included (filtered by the current source)</span>
      </div>

      {/* Aggregate table */}
      <div className="pg-mtable-wrap">
        <table className="pg-mtable">
          <thead>
            <tr>
              <th>Config</th>
              <th>n</th>
              <th>Success rate</th>
              <th>Avg tokens</th>
              <th>Avg latency</th>
              <th>Avg cost</th>
              <th title="Success rate measured on the same tasks as C0, one count per task. The /Nt suffix is how many tasks that comparison covers. This is also the MeanLift of the three lower-tail columns to its right.">lift vs C0 (paired)</th>
              <th title="Worst paired-task lift — the single task where this config fell furthest behind C0. Negative means at least one task got worse.">WorstLift</th>
              <th title="Share of paired tasks where this config beat C0. Low values mean the average lift is carried by a few lucky tasks.">RR₀</th>
              <th title="5th percentile of the bootstrapped mean-lift distribution — what the lift still guarantees on a bad draw. Same math as the WindTunnel lower-tail panel.">RelLift₉₅</th>
            </tr>
          </thead>
          <tbody>
            {metrics?.groups.map((g) => (
              <tr key={g.fingerprint}>
                <td className="pg-mtable-label" title={g.title ?? undefined}>{g.label}</td>
                <td title={`${g.runs} run(s) over ${g.distinctTasks} distinct task(s) — repeats of the same task add runs, not independent evidence`}>
                  {g.runs}
                  {g.distinctTasks < g.runs && (
                    <span className="faint" style={{ fontSize: 10 }}> / {g.distinctTasks} tasks</span>
                  )}
                </td>
                <td>
                  {/* successRate 已是百分数（服务端 pct() 转过一次），这里再乘 100 会显示成 1630% */}
                  {g.successRate != null ? `${g.successRate}%` : '—'}
                </td>
                <td>{g.avgTokens ? fmt(g.avgTokens) : '—'}</td>
                <td>{g.avgLatencyMs ? `${Math.round(g.avgLatencyMs / 1000)}s` : '—'}</td>
                <td title={g.avgCostUsd == null ? 'The model this config used is not in the price table; cost is left empty rather than invented' : undefined}>
                  {fmtUsd(g.avgCostUsd)}
                </td>
                <td
                  title={
                    g.liftPairedTasks == null
                      ? 'Not enough tasks in common with C0 to compare'
                      : `Head-to-head on the ${g.liftPairedTasks} task(s) both configs ran, one count per task. Not the same as subtracting the success rates on the left — this config ran a different set of tasks than C0.`
                  }
                >
                  {g.liftVsC0Pp != null
                    ? `${g.liftVsC0Pp >= 0 ? '+' : ''}${Math.round(g.liftVsC0Pp)} pp`
                    : '—'}
                  {g.liftPairedTasks != null && (
                    <span className="faint" style={{ fontSize: 10 }}> /{g.liftPairedTasks}t</span>
                  )}
                  {/* Same fragile rule as the WindTunnel lower-tail panel: a
                      positive mean hiding a negative worst task or a low win
                      rate. Shown next to the mean so the warning cannot be
                      read past. */}
                  {g.liftVsC0Pp != null &&
                    g.worstLiftPp != null &&
                    g.rr0 != null &&
                    g.liftVsC0Pp > 0 &&
                    (g.worstLiftPp < 0 || g.rr0 < 0.75) && (
                      <span
                        style={{ color: 'var(--red)', marginLeft: 4 }}
                        title={`Mean lift is positive but the worst paired task is ${Math.round(g.worstLiftPp)} pp and only ${Math.round(g.rr0 * 100)}% of paired tasks improved — the average hides a tail risk`}
                      >
                        ⚠ fragile
                      </span>
                    )}
                </td>
                <td title={g.worstLiftPp == null ? 'Not enough tasks in common with C0 to compare' : 'The single paired task where this config did worst vs C0; negative = at least one task got worse'}>
                  {g.worstLiftPp != null ? `${g.worstLiftPp >= 0 ? '+' : ''}${Math.round(g.worstLiftPp)} pp` : '—'}
                </td>
                <td title={g.rr0 == null ? 'Not enough tasks in common with C0 to compare' : 'Share of paired tasks where this config beat C0'}>
                  {g.rr0 != null ? `${Math.round(g.rr0 * 100)}%` : '—'}
                </td>
                <td title={g.relLift95Pp == null ? 'Not enough tasks in common with C0 to compare' : '5th percentile of the bootstrapped mean-lift distribution — the lift that survives a bad draw'}>
                  {g.relLift95Pp != null ? `${g.relLift95Pp >= 0 ? '+' : ''}${Math.round(g.relLift95Pp)} pp` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Failure mode × config */}
      <div className="pg-sub-title">Failure mode × config distribution</div>
      <div className="pg-hmap-wrap">
        <table className="pg-hmap">
          <thead>
            <tr>
              <th className="pg-hmap-rowhead">Failure tag</th>
              {fail.cols.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fail.tags.map((tag) => (
              <tr key={tag}>
                <td className="pg-hmap-rowhead">{tag}</td>
                {fail.cols.map((c) => {
                  const cell = fail.cells[tag]![c.key]!
                  return (
                    <td key={c.key}>
                      <div
                        className="pg-hmap-cell"
                        style={{ background: heatColor(cell) }}
                        title={`${tag} @ ${c.label}: ${cell.count}/${cell.total}`}
                      >
                        {cell.count || ''}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
            {fail.tags.length === 0 && (
              <tr><td className="pg-hmap-rowhead" colSpan={fail.cols.length + 1}>No failure tags</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pareto */}
      <div className="pg-sub-title">Quality–cost Pareto</div>
      <ParetoChart runs={runs} />

      {/* Model × harness */}
      <div className="pg-sub-title">Model × harness cross (when swapping the LLM)</div>
      <div className="pg-hmap-wrap">
        <table className="pg-hmap">
          <thead>
            <tr>
              <th className="pg-hmap-rowhead">Model</th>
              {cross.cols.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cross.models.map((m) => (
              <tr key={m}>
                <td className="pg-hmap-rowhead">{m}</td>
                {cross.cols.map((c) => {
                  const cell = cross.cells[m]![c.key]!
                  return (
                    <td key={c.key}>
                      <div
                        className="pg-hmap-cell rate"
                        style={{ background: rateColor(cell.rate) }}
                        title={`${m} @ ${c.label}: n=${cell.n}`}
                      >
                        {cell.rate === null ? '—' : `${Math.round(cell.rate * 100)}%`}
                      </div>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
