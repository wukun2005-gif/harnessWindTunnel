/**
 * 一次性探针：确认 mercury-decide:free 在「判分依据」新题型下的返回形状。
 *   - score 读数是 0 起还是 1 起（决定档位文案与 0–1 分数换算）
 *   - 新加的 reason 题（原因清单 choice）能不能被正确解析
 * 用法：npx tsx scripts/probe-basis.ts [taskId]
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { getTask } from '../server/playground/evalset'
import { buildJudgeState, judgeBasis } from '../server/playground/jevJudge'
import { buildJudgeQuestions, parseJudgeAnswers } from '../server/playground/jevClient'

const ROOT = process.cwd()
const OR = 'https://openrouter.ai/api/v1/systemone'

function key(): string {
  const s = JSON.parse(readFileSync(path.join(ROOT, 'server-data', 'settings.json'), 'utf8')) as {
    provider_all: { providers: Array<Record<string, string>> }
  }
  for (const p of s.provider_all.providers) {
    if (p.providerId === 'openrouter-jev') return p.apiKeyRef || p.apiKey || ''
  }
  return ''
}

async function call(state: string): Promise<unknown> {
  const res = await fetch(OR, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key()}` },
    body: JSON.stringify({ model: 'inception/mercury-decide:free', state, questions: buildJudgeQuestions() }),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text)
}

const taskId = process.argv[2] ?? 'G1'
const task = getTask(taskId)
if (!task) throw new Error(`no task ${taskId}`)

for (const [label, answer] of [['good', task.referenceAnswer ?? ''], ['bad', (task as { badAnswer?: string }).badAnswer ?? '']] as const) {
  if (!answer) continue
  const state = buildJudgeState(task, answer).state
  const payload = await call(state)
  const parsed = parseJudgeAnswers(payload, buildJudgeQuestions())
  console.log(`\n=== ${taskId} ${label} ===`)
  console.log('answers:', JSON.stringify((payload as { answers?: unknown }).answers, null, 1))
  console.log('parsed choice  :', JSON.stringify(parsed.choice))
  console.log('parsed reason  :', JSON.stringify(parsed.reason))
  console.log('parsed score   :', JSON.stringify(parsed.score))
  console.log('basis (翻译):')
  console.log(judgeBasis(parsed))
}
