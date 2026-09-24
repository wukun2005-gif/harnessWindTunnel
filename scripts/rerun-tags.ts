// P1-C 失败标签新纪元重跑：金标集合化（10 题）后全量 60 条读数。
// 用法：npx tsx scripts/rerun-tags.ts
import { randomUUID } from 'node:crypto'

const BASE = 'http://localhost:4000'
const batchId = `tags-${randomUUID().slice(0, 8)}`

type Task = { id: string }
const tasksRes = await fetch(`${BASE}/api/playground/tags/tasks`)
const tasksBody = (await tasksRes.json()) as { tasks?: Task[] } & Task[]
const tasks = tasksBody.tasks ?? (tasksBody as unknown as Task[])

const kinds: Array<'good' | 'bad'> = ['good', 'bad']
const ROUNDS = 3

console.log(`batch=${batchId} tasks=${tasks.length} total=${tasks.length * kinds.length * ROUNDS}`)

let done = 0
const started = Date.now()
for (const t of tasks) {
  for (const kind of kinds) {
    for (let r = 0; r < ROUNDS; r++) {
      const res = await fetch(`${BASE}/api/playground/tags/judge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagId: t.id, kind, batchId }),
      })
      const body = (await res.json()) as { ok?: boolean; error?: string; result?: { source?: string; error?: string } }
      done++
      const src = body.result?.source ?? (body.ok ? '?' : 'FAIL')
      console.log(
        `[${done}/60] ${t.id} ${kind} r${r + 1} → ${src}` +
          (body.result?.error ? ` (${String(body.result.error).slice(0, 120)})` : body.error ? ` (${body.error})` : ''),
      )
    }
  }
}
console.log(`DONE batch=${batchId} elapsedMs=${Date.now() - started}`)
