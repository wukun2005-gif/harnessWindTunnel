// P2 replay audit: run every already-recorded live run through its task
// contract, without re-running anything. This is the "does the rulebook
// misfire on real data" check from the P2 plan — contracts are written from a
// handful of samples, so they must be exercised against the whole recorded
// corpus before anyone trusts a reading.
//
// Read-only: it opens the playground DB for reads, never writes, never calls a
// model. Output is a deterministic JSON + a human-readable table.
//
// Usage: npx tsx scripts/trajectory-replay.ts [--json]
import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { listRuns, getRunDetail } from '../server/playground/liveDb'
import { getLiveContractForTask, loadLiveContracts } from '../server/trajectoryStore'
import { evaluateEvents } from '../shared/trajectoryEval'
import type { TrajectoryCell, TrajectoryVerdictDetail } from '../shared/trajectory'

// Every eval task now carries a task-level contract; the audit covers all of
// them rather than a pilot subset.
const TASKS = loadLiveContracts().map((c) => c.target.id).sort()
const CELLS: Array<TrajectoryCell | 'process-incomplete' | 'unknown'> = [
  'trusted-success', 'fluke-success', 'one-step-short', 'clear-failure', 'process-incomplete', 'unknown',
]

interface RunReading {
  runId: string
  taskId: string
  fingerprint: string
  configLabel: string
  createdAt: string
  status: string
  /** run.finished.success — the terminal state the band reads (never rewritten). */
  terminalSuccess: boolean | null
  /** pg_runs.success — the judge/scorer verdict, kept separate on purpose. */
  dbSuccess: boolean | null
  score: number | null
  eventCount: number
  cell: TrajectoryCell | null
  bucket: (typeof CELLS)[number]
  csr: number | null
  hardViolation: boolean
  softViolations: number
  firstDivergence: number | null
  processIncomplete: boolean
  checkpointsDone: number
  checkpointsRequired: number
  /** Checkpoint ids that never fired — the usual suspect when a reading looks wrong. */
  missingCheckpoints: string[]
  toolCalls: number
}

function bucketOf(v: TrajectoryVerdictDetail): (typeof CELLS)[number] {
  if (v.cell) return v.cell
  if (v.processIncomplete) return 'process-incomplete'
  return 'unknown'
}

function readRun(runId: string): RunReading | null {
  const detail = getRunDetail(runId)
  if (!detail || detail.events.length === 0) return null
  const contract = getLiveContractForTask(detail.taskId)
  if (!contract) return null
  const v = evaluateEvents(contract, detail.events, detail.source === 'imported' ? 'imported' : 'live')
  const required = v.checkpoints.filter((c) => c.kind === 'required')
  return {
    runId,
    taskId: detail.taskId,
    fingerprint: detail.fingerprint,
    configLabel: detail.configLabel,
    createdAt: detail.createdAt,
    status: detail.status,
    terminalSuccess: v.terminalSuccess,
    dbSuccess: detail.success,
    score: detail.score,
    eventCount: detail.events.length,
    cell: v.cell,
    bucket: bucketOf(v),
    csr: v.csr,
    hardViolation: v.hardViolation,
    softViolations: v.softViolations,
    firstDivergence: v.firstDivergence,
    processIncomplete: v.processIncomplete,
    checkpointsDone: required.filter((c) => c.completed).length,
    checkpointsRequired: required.length,
    missingCheckpoints: required.filter((c) => !c.completed && !c.unknown).map((c) => c.id),
    toolCalls: detail.events.filter((e) => e.type === 'tool.call').length,
  }
}

function main(): void {
  const json = process.argv.includes('--json')
  const readings: RunReading[] = []
  const skipped: string[] = []
  for (const taskId of TASKS) {
    if (!getLiveContractForTask(taskId)) { skipped.push(`${taskId}: no contract`); continue }
    const runs = listRuns({ taskId, limit: 500 })
    for (const r of runs) {
      const reading = readRun(r.runId)
      if (reading) readings.push(reading)
    }
  }

  const perTask = TASKS.map((taskId) => {
    const mine = readings.filter((r) => r.taskId === taskId)
    const dist = Object.fromEntries(CELLS.map((c) => [c, mine.filter((r) => r.bucket === c).length]))
    const successRuns = mine.filter((r) => r.terminalSuccess === true)
    const trusted = successRuns.filter((r) => r.bucket === 'trusted-success').length
    // The judge and the terminal state are allowed to disagree; the replay
    // reports both so a reading is never silently blamed on the wrong column.
    const judgeDisagrees = mine.filter((r) => r.dbSuccess !== null && r.terminalSuccess !== null && r.dbSuccess !== r.terminalSuccess).length
    // Misfire signals: a contract that declares a step real runs never perform
    // shows up as one checkpoint missing across nearly every run.
    const missingCount = new Map<string, number>()
    for (const r of mine) for (const id of r.missingCheckpoints) missingCount.set(id, (missingCount.get(id) ?? 0) + 1)
    const suspicious = [...missingCount.entries()]
      .filter(([, n]) => mine.length >= 3 && n / mine.length >= 0.8)
      .map(([id, n]) => ({ id, n, share: Number((n / mine.length).toFixed(2)) }))
    return {
      taskId,
      runs: mine.length,
      successRuns: successRuns.length,
      trustedSuccess: trusted,
      trustedRate: successRuns.length ? Number((trusted / successRuns.length).toFixed(2)) : null,
      judgeDisagrees,
      hardViolations: mine.filter((r) => r.hardViolation).length,
      processIncomplete: mine.filter((r) => r.processIncomplete).length,
      cells: dist,
      missingCheckpoints: suspicious,
      zeroToolCallRuns: mine.filter((r) => r.toolCalls === 0).length,
    }
  })

  const report = {
    generatedFrom: 'server-data/playground.db',
    tasks: TASKS,
    totalRuns: readings.length,
    perTask,
    skipped,
    runs: readings,
  }

  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2))
    return
  }

  console.log(`Replayed ${readings.length} recorded runs against ${TASKS.length} task contracts (no re-run, no model call).`)
  if (skipped.length) console.log(`Skipped: ${skipped.join('; ')}`)
  for (const t of perTask) {
    console.log(`\n${t.taskId}  runs=${t.runs}  success=${t.successRuns}  trusted=${t.trustedSuccess}/${t.successRuns}`)
    console.log(`  cells: ${CELLS.map((c) => `${c}=${t.cells[c]}`).join('  ')}`)
    console.log(`  hard=${t.hardViolations}  process-incomplete=${t.processIncomplete}  zero-tool-call=${t.zeroToolCallRuns}  judge≠terminal=${t.judgeDisagrees}`)
    for (const m of t.missingCheckpoints) console.log(`  ⚠ checkpoint "${m.id}" missing in ${m.n}/${t.runs} runs (${m.share}) — contract may be too narrow`)
  }
  const out = resolve('data', 'trajectory', 'replay-report.json')
  if (existsSync(resolve('data', 'trajectory'))) {
    writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
    console.log(`\nwrote ${out}`)
  }
}

main()
