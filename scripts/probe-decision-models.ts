/**
 * OpenRouter decision 模型评测（探针 + 全量两用）。
 *
 * 协议完全复用 app 自己的实现：`callSystemOne`（{model, state, questions} →
 * POST {baseUrl}/systemone）+ `buildJudgeState()` + `buildJudgeQuestions()`。
 * 探针只换 baseUrl 和 model，不另立一套调用约定。
 *
 * 两种模式：
 *   --probe（默认）在 3 道题的好/坏答案对上跑，回答两个入门前问题：
 *       能不能返回可解析的概率读数？能不能把已知好答案和已知坏答案分开？
 *       数据来源：题库的 referenceAnswer（好）与 badAnswer（坏）。
 *   --full 在**最终有效的 270 条 run** 上跑，产出可与判分器报告直接对比的读数。
 *       run 明细直接从 sqlite 读（不经 HTTP，270 条一次查完）。
 *
 * 用例：
 *   npx tsx scripts/probe-decision-models.ts
 *   npx tsx scripts/probe-decision-models.ts --full
 *   npx tsx scripts/probe-decision-models.ts --full --models inception/mercury-decide:free
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { getTask } from '../server/playground/evalset'
import { buildJudgeState } from '../server/playground/jevJudge'
import { buildJudgeQuestions, callSystemOne, type JevTarget } from '../server/playground/jevClient'

const ROOT = process.cwd()
const SETTINGS = path.join(ROOT, 'server-data', 'settings.json')
const DB_PATH = path.join(ROOT, 'server-data', 'playground.db')
const STATE_MAIN = path.join(ROOT, 'server-data', 'batch270', 'state.json')
const STATE_C2WEB = path.join(ROOT, 'server-data', 'batch270', 'state-c2web.json')
const OUT_DIR = path.join(ROOT, 'server-data', 'batch270')
const OR_BASE = 'https://openrouter.ai/api/v1'

/** 探针阶段入选的 7 个（现任 typesafe/jev-1.13 不跑：报告里 jev 那一列就是它的 270 条基准）。 */
const MODELS = [
  'inception/mercury-decide:free',
  'inception/mercury-decide',
  'perplexity/pplx-decider-v1.1-27b',
  'microsoft/microsoft-decision-1',
  'togethercomputer/tev1-4b-experimental',
  'nace-ai/drex-v1.5',
  'liquid/d1',
]

const PROBE_TASKS = ['G1', 'L1', 'S1']

function openrouterKey(): string {
  const s = JSON.parse(readFileSync(SETTINGS, 'utf8')) as { provider_all?: { providers?: Array<Record<string, unknown>> } }
  for (const p of s.provider_all?.providers ?? []) {
    if (p['providerId'] === 'openrouter') {
      const k = String(p['apiKeyRef'] ?? p['apiKey'] ?? '').trim()
      if (k) return k
    }
  }
  return ''
}

function log(line: string) {
  const s = `[${new Date().toTimeString().slice(0, 8)}] ${line}`
  console.log(s)
  try { appendFileSync(path.join(OUT_DIR, 'decision-eval.log'), s + '\n') } catch { /* ignore */ }
}

/** 最终有效集合 = 主批次非 C2 + c2web 全部（与评测报告同一口径）。 */
function finalRunIds(): Array<{ runId: string; taskId: string }> {
  const out: Array<{ runId: string; taskId: string }> = []
  const push = (units: Array<Record<string, unknown>>, skipC2: boolean) => {
    for (const u of units) {
      if (skipC2 && u['presetId'] === 'C2') continue
      const rid = (u['acceptedRunId'] ?? u['runId']) as string | null
      if (rid) out.push({ runId: rid, taskId: String(u['taskId']) })
    }
  }
  push((JSON.parse(readFileSync(STATE_MAIN, 'utf8')) as { units: Array<Record<string, unknown>> }).units, true)
  push((JSON.parse(readFileSync(STATE_C2WEB, 'utf8')) as { units: Array<Record<string, unknown>> }).units, false)
  return out
}

interface CallResult {
  ok: boolean
  choice?: string | null
  confidence?: number | null
  probabilities?: Record<string, number> | null
  latencyMs?: number
  inputTokens?: number
  cost?: number
  error?: string
}

/** 带退避的重试：撞 429 不能把这条 run 变成"模型不行"。 */
async function callWithRetry(target: JevTarget, state: string, questions: ReturnType<typeof buildJudgeQuestions>, tries = 4): Promise<CallResult> {
  let last = ''
  for (let i = 0; i < tries; i++) {
    try {
      const r = await callSystemOne(target, state, questions, { timeoutMs: 90_000 })
      const c = r.readings.choice
      if (!c) { last = '响应里没有 choice 读数'; }
      else {
        return { ok: true, choice: c.choice, confidence: c.confidence, probabilities: c.probabilities, latencyMs: r.latencyMs, inputTokens: r.usage?.inputTokens }
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
      // 4xx（除 429）是形状问题，重试无意义
      if (/\b(400|401|402|403|404|413|422)\b/.test(last) && !/429/.test(last)) break
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)))
  }
  return { ok: false, error: last, latencyMs: 0 }
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined }
  const full = process.argv.includes('--full')
  const models = arg('--models')?.split(',').map((s) => s.trim()).filter(Boolean) ?? MODELS
  const conc = Number(arg('--concurrency') ?? 6) || 6
  const apiKey = openrouterKey()
  if (!apiKey) { console.error('设置里没有 openrouter key'); process.exit(1) }

  const questions = buildJudgeQuestions()

  // ── 组装样本 ─────────────────────────────────────────────────────────────
  let samples: Array<{ key: string; label: string; state: string }>
  if (full) {
    const ids = finalRunIds()
    const db = new DatabaseSync(DB_PATH, { readOnly: true })
    const sel = db.prepare('SELECT task_id, answer FROM pg_runs WHERE run_id = ?')
    samples = []
    for (const { runId, taskId } of ids) {
      const row = sel.get(runId) as unknown as { task_id: string; answer: string | null } | undefined
      if (!row) continue
      const task = getTask(row.task_id) ?? getTask(taskId)
      if (!task) continue
      samples.push({ key: runId, label: `${row.task_id}`, state: buildJudgeState(task, row.answer ?? '').state })
    }
    db.close()
    log(`=== 全量评测 === 模型 ${models.length} 个，run ${samples.length} 条/模型，并发 ${conc}`)
  } else {
    const tasks = (arg('--tasks') ?? PROBE_TASKS.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
    samples = []
    for (const tid of tasks) {
      const task = getTask(tid)
      if (!task) continue
      const bad = (task as unknown as { badAnswer?: string }).badAnswer ?? ''
      if (task.referenceAnswer) samples.push({ key: `${tid}|good`, label: tid, state: buildJudgeState(task, task.referenceAnswer).state })
      if (bad) samples.push({ key: `${tid}|bad`, label: tid, state: buildJudgeState(task, bad).state })
    }
    log(`=== 探针 === 模型 ${models.length} 个，样本 ${samples.length} 条/模型，并发 ${conc}`)
  }

  const results: Record<string, Record<string, CallResult>> = {}
  let cursor = 0
  async function worker() {
    while (cursor < models.length) {
      const model = models[cursor++]
      const mine: Record<string, CallResult> = {}
      results[model] = mine
      const started = Date.now()
      let done = 0
      let next = 0
      const inner = async () => {
        while (next < samples.length) {
          const s = samples[next++]
          const target: JevTarget = { providerId: 'openrouter', baseUrl: OR_BASE, apiKey, model }
          mine[s.key] = await callWithRetry(target, s.state, questions)
          done++
          if (done % 50 === 0) log(`  ${model} ${done}/${samples.length}`)
        }
      }
      await Promise.all(Array.from({ length: Math.min(conc, samples.length) }, () => inner()))
      const oks = Object.values(mine).filter((v) => v.ok)
      const lats = oks.map((v) => v.latencyMs ?? 0).sort((a, b) => a - b)
      const cost = oks.reduce((a, v) => a + (v.cost ?? 0), 0)
      log(`  ${model.padEnd(38)} 可用 ${oks.length}/${samples.length}  ` +
          `延迟中位 ${lats[Math.floor(lats.length / 2)] ?? 0}ms  耗时 ${((Date.now() - started) / 1000).toFixed(0)}s`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(conc, models.length) }, () => worker()))

  const suffix = full ? 'full' : 'probe'
  for (const m of models) {
    const f = path.join(OUT_DIR, `decision-${suffix}-${m.replace(/[/:]/g, '_')}.json`)
    writeFileSync(f, JSON.stringify({ model: m, at: new Date().toISOString(), samples: samples.length, results: results[m] }, null, 1))
    log(`  written: ${path.basename(f)}`)
  }
  log('=== 完成 ===')
}

main().catch((e) => { console.error(e); process.exit(1) })
