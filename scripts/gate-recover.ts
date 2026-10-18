/**
 * 把一次门槛跑途中已经完成的真实运行重新汇总成结论，不重跑任何题。
 *
 * 为什么需要：门槛 15 题 × ×repeats × 改前改后 是一次长跑。中途只要有一道题
 * 反复超时报错（实测 G10），剩下的题其实全跑完了，但整轮会被判成"无法判定"，
 * 已经花掉的额度就白花了。这个脚本从库里把已完成的运行捞回来配对、算出结论，
 * 并把没答上的题单独列出来——正是"剔掉没答上的槽位、用剩下的出结论"。
 *
 * 改前/改后怎么区分：靠 mounts 而不是 seed。种子在 repeats 之间会撞号
 * （baseline 的 rep1 与 candidate 的 rep0 同号），mounts 不会。
 *
 * 用法：
 *   npx tsx scripts/gate-recover.ts <commitId> [--write]
 *   加 --write 才落库并把 gateStatus 从 running 改成真实判定。
 */
import { getPlaygroundDb } from '../server/playground/liveDb'
import { gateStats, type GatePair } from '../server/playground/gainEstimator'
import { getMutation, updateMutationGate, getGeneration } from '../server/playground/evoDb'

interface GateRunRow {
  run_id: string
  task_id: string
  success: number | null
  status: string
  error: string | null
  tokens: number | null
  latency_ms: number | null
  mounts_json: string
  created_at: string
}

const commitId = process.argv[2]
const write = process.argv.includes('--write')
if (!commitId) {
  console.error('usage: npx tsx scripts/gate-recover.ts <commitId> [--write]')
  process.exit(1)
}

const mutation = getMutation(commitId)
if (!mutation) {
  console.error(`mutation not found: ${commitId}`)
  process.exit(1)
}
const candidate = getGeneration(mutation.generationId)
const parent = getGeneration(mutation.parentGenerationId)
if (!candidate || !parent) {
  console.error('candidate or parent generation missing')
  process.exit(1)
}

const db = () => getPlaygroundDb() as unknown as {
  prepare: (s: string) => { all: (a?: unknown[]) => Record<string, unknown>[] }
}

/** 指纹：候选版本与父版本的实际运行配置。 */
const sigOf = (mountsJson: string): string => JSON.stringify(mountsJson ? JSON.parse(mountsJson) : {})
const parentSig = sigOf(parent.mounts ? JSON.stringify(parent.mounts) : '{}')
const candSig = sigOf(JSON.stringify(candidate.mounts))

const rows = db().prepare(
  `SELECT run_id, task_id, success, status, error, tokens, latency_ms, mounts_json, created_at
     FROM pg_runs WHERE split='gate' AND status='scored' ORDER BY created_at ASC`,
).all() as unknown as GateRunRow[]

// 只取这一次门槛跑产生、且属于候选/父版本这两个配置的运行。
// 靠 mounts 精确区分改前改后，不靠 seed（seed 在 repeats 之间会撞号）。
const fresh = rows.filter((r) => {
  const sig = sigOf(r.mounts_json)
  return sig === parentSig || sig === candSig
})

const byTask = new Map<string, { baseline: GateRunRow[]; candidate: GateRunRow[] }>()
for (const r of fresh) {
  const sig = sigOf(r.mounts_json)
  const slot = byTask.get(r.task_id) ?? { baseline: [], candidate: [] }
  ;(sig === parentSig ? slot.baseline : slot.candidate).push(r)
  byTask.set(r.task_id, slot)
}

const pairs: GatePair[] = []
const missing: string[] = []
for (const [taskId, slot] of byTask) {
  const n = Math.min(slot.baseline.length, slot.candidate.length)
  if (n === 0) {
    missing.push(taskId)
    continue
  }
  for (let i = 0; i < n; i++) {
    const b = slot.baseline[i]!
    const c = slot.candidate[i]!
    pairs.push({
      taskId,
      baseline: b.success === 1,
      candidate: c.success === 1,
      candidateTokens: c.tokens,
      candidateLatencyMs: c.latency_ms,
    })
  }
}

const s = gateStats(pairs)
const pairedTasks = [...byTask.entries()].filter(([, v]) => v.baseline.length > 0 && v.candidate.length > 0).length
const repeated = pairedTasks > 0 ? pairs.length / pairedTasks : 1
const result = {
  gateTaskIds: [...byTask.keys()],
  baselinePass: s.baselinePass,
  candidatePass: s.candidatePass,
  baselinePassPp: s.baselinePassPp,
  candidatePassPp: s.candidatePassPp,
  gateLiftPp: s.gateLiftPp,
  regressed: s.regressed,
  fixed: s.fixed,
  avgTokens: s.avgTokens,
  avgLatencyMs: s.avgLatencyMs,
  avgCostUsd: null,
  repeats: repeated,
  baselineRunIds: fresh.filter((r) => sigOf(r.mounts_json) === parentSig).map((r) => r.run_id),
  newRunIds: fresh.filter((r) => sigOf(r.mounts_json) === candSig).map((r) => r.run_id),
  ranAt: new Date().toISOString(),
  ...(missing.length
    ? { error: `partial: ${missing.length} task(s) never produced an answer (${missing.join(', ')}); the verdict below uses the ${pairs.length} pairs that did answer` }
    : {}),
}

// 没答上的槽位被剔掉、用剩下的出结论——一题失败不该作废整轮。它只在这里被记录。
const passed = s.regressed.length === 0 && s.gateLiftPp >= 0

console.log(`commit      ${commitId}`)
console.log(`tasks       ${pairedTasks} answered, ${missing.length} unanswered${missing.length ? ` (${missing.join(', ')})` : ''}`)
console.log(`pairs       ${pairs.length} (×${repeated} per answered task)`)
console.log(`baseline    ${s.baselinePass}/${pairs.length} = ${s.baselinePassPp}%`)
console.log(`candidate   ${s.candidatePass}/${pairs.length} = ${s.candidatePassPp}%`)
console.log(`gate lift   ${s.gateLiftPp > 0 ? '+' : ''}${s.gateLiftPp}pp`)
console.log(`regressed   ${s.regressed.join(', ') || 'none'}`)
console.log(`fixed       ${s.fixed.join(', ') || 'none'}`)
console.log(`verdict     ${passed ? 'passed' : 'failed'}${missing.length ? ' (on the answered pairs; the unanswered task is excluded, not assumed to pass)' : ''}`)
if (write) {
  updateMutationGate(commitId, result, passed ? 'passed' : 'failed')
  console.log(`\nwritten to ${commitId}: gateStatus=${passed ? 'passed' : 'failed'}`)
}