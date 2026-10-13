/**
 * 一次性回填：把老 run 的判分读数用判定模型（inception/mercury-decide:free）完整重判一遍，
 * 覆盖主槽里旧判分器（jev-1.13.0）的读数。
 *
 * 只调判定模型这一个接口（System One）。金标要点命中、法条核验、安全门、失败标签这些
 * 确定性证据都在库里，原样保留；对话模型、知识库、搜索一概不碰。
 *
 * 重判成功后同步更新这条 run 的结论（success / score / summary 由判定模型给），
 * 其余字段（factChecks / rouge / articleChecks / failureTags）不动。
 * 调用失败（限流 / 断网）保留旧记录不覆盖，末尾汇总打印，可重跑续填。
 *
 * 用法：npx tsx scripts/backfill-mercury.ts [--limit N] [--dry] [--all]
 *   --all = 已经是判定模型的记录也重新判一遍（用于给老记录补「要点逐条核对」）。
 */
import { getRunDetail, listRuns, patchRun } from '../server/playground/liveDb'
import { runJevJudge } from '../server/playground/jevJudge'
import { getTask } from '../server/playground/evalset'
import { isUiJudgeModel } from '../src/screens/Playground/channelText'
import type { ScoreResult } from '../shared/playground'

const CONCURRENCY = 4
const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const ALL = args.includes('--all')
const limitIdx = args.indexOf('--limit')
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) ?? Infinity : Infinity

interface Job {
  runId: string
  taskId: string
  answer: string
  assertions: Array<{ citedAuthority: string; label: string }>
}

const summaries = listRuns({ limit: 500 })
const jobs: Job[] = []
let alreadyMercury = 0
let skipped = 0

for (const s of summaries) {
  const d = getRunDetail(s.runId)
  if (!d) continue
  if (!ALL && isUiJudgeModel(d.jevResult?.model)) {
    alreadyMercury++
    continue
  }
  if (!d.answer || d.status !== 'scored') {
    skipped++
    continue
  }
  const task = getTask(d.taskId)
  if (!task) {
    skipped++
    continue
  }
  jobs.push({
    runId: s.runId,
    taskId: d.taskId,
    answer: d.answer,
    assertions: (d.events ?? [])
      .filter((e) => e.type === 'legal.assertion')
      .map((e) => {
        const a = e as Extract<(typeof d.events)[number], { type: 'legal.assertion' }>
        return { citedAuthority: a.citedAuthority, label: a.label }
      }),
  })
}

const todo = jobs.slice(0, LIMIT)
console.log(
  `待回填 ${todo.length} 条（已是判定模型 ${alreadyMercury} 条，跳过 ${skipped} 条）` +
    `${DRY ? ' —— dry run，不写库' : ''}`,
)

let done = 0
let ok = 0
const failures: Array<{ runId: string; taskId: string; error: string }> = []

async function worker(): Promise<void> {
  for (;;) {
    const job = todo.shift()
    if (!job) return
    const task = getTask(job.taskId)
    if (!task) continue
    try {
      const judge = await runJevJudge(task, job.answer, { batchId: job.runId, assertions: job.assertions })
      if (judge.source !== 'decided' || judge.success == null) {
        failures.push({ runId: job.runId, taskId: job.taskId, error: judge.error ?? judge.reason })
      } else if (!DRY) {
        const detail = getRunDetail(job.runId)
        const verdict = detail?.verdict as ScoreResult | null
        patchRun(job.runId, { jevResult: judge })
        if (verdict) {
          patchRun(job.runId, {
            verdict: { ...verdict, success: judge.success, score: judge.score ?? (judge.success ? 1 : 0), summary: judge.reason },
            success: judge.success,
            score: judge.score ?? (judge.success ? 1 : 0),
          })
        }
        ok++
      } else {
        ok++
      }
    } catch (err) {
      failures.push({ runId: job.runId, taskId: job.taskId, error: err instanceof Error ? err.message : String(err) })
    }
    done++
    if (done % 20 === 0) {
      console.log(`  ${done}/${todo.length} · 成功 ${ok} · 失败 ${failures.length}`)
    }
  }
}

const t0 = Date.now()
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
const secs = ((Date.now() - t0) / 1000).toFixed(1)

console.log(`\n完成：成功 ${ok}，失败 ${failures.length}，用时 ${secs}s`)
if (failures.length > 0) {
  console.log('失败明细（保留旧读数未覆盖，可重跑续填）：')
  for (const f of failures.slice(0, 20)) console.log(`  ${f.taskId} ${f.runId}: ${f.error}`)
  if (failures.length > 20) console.log(`  … 另有 ${failures.length - 20} 条`)
}
