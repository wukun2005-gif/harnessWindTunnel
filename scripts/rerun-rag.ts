// P1-E RAG 支撑度金标修订（7 组好答案回到冻结 passage 原文内）后的全量 96 条新纪元读数。
// 用法：npx tsx scripts/rerun-rag.ts（需 server :4000 在跑）
import { randomUUID } from 'node:crypto'

const BASE = 'http://localhost:4000'
const batchId = `rag-${randomUUID().slice(0, 8)}`

type Task = { id: string }
const tasksRes = await fetch(`${BASE}/api/playground/rag/tasks`)
const tasksBody = (await tasksRes.json()) as { tasks?: Task[] } & Task[]
const tasks = tasksBody.tasks ?? (tasksBody as unknown as Task[])

const kinds: Array<'good' | 'bad'> = ['good', 'bad']
const ROUNDS = 3
const TOTAL = tasks.length * kinds.length * ROUNDS

console.log(`batch=${batchId} tasks=${tasks.length} total=${TOTAL}`)

let done = 0
const started = Date.now()
for (const t of tasks) {
  for (const kind of kinds) {
    for (let r = 0; r < ROUNDS; r++) {
      const res = await fetch(`${BASE}/api/playground/rag/judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ragId: t.id, kind, batchId }),
      })
      const body = (await res.json()) as { ok?: boolean; error?: string; result?: { source?: string; error?: string } }
      done++
      const src = body.result?.source ?? (body.ok ? '?' : 'FAIL')
      console.log(
        `[${done}/${TOTAL}] ${t.id} ${kind} r${r + 1} → ${src}` +
          (body.result?.error ? ` (${String(body.result.error).slice(0, 120)})` : body.error ? ` (${body.error})` : ''),
      )
    }
  }
}
console.log(`DONE batch=${batchId} elapsedMs=${Date.now() - started}`)
