// 一键全测运行器（M1 §17.9）：状态住在模块内存，不住组件里。
// 切换页签、切到别的路由都不会中断也不会丢进度，回来续看。
// 取消后停在当前单元。trap 题每档答案追加去注入对照轮（配对实验）。
import { api } from '../../api'
import type { PlaygroundTaskList } from '../../../shared/playground'

export interface BatchUnitResult {
  taskId: string
  kind: 'good' | 'bad'
  round: number
  variant: 'clean' | null
  ok: boolean
  choice?: string | null
  consistent?: string | null
  success?: boolean | null
  error?: string | null
}

export interface BatchSnapshot {
  running: boolean
  done: number
  total: number
  current: { taskId: string; kind: 'good' | 'bad'; round: number; variant: 'clean' | null } | null
  results: BatchUnitResult[]
  batchId: string
  /** 选题：null = 全选，否则为选中的 taskId。 */
  selected: string[] | null
  /** 自然跑完（非取消）时为 true，页签消费后清掉，用于跑完自动跳分析视图。 */
  completed: boolean
}

const idle: BatchSnapshot = { running: false, done: 0, total: 0, current: null, results: [], batchId: '', selected: null, completed: false }
let snapshot: BatchSnapshot = { ...idle }
const listeners = new Set<() => void>()

function setSnapshot(next: Partial<BatchSnapshot>): void {
  snapshot = { ...snapshot, ...next }
  listeners.forEach((l) => l())
}

export function subscribeBatch(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getBatchSnapshot(): BatchSnapshot {
  return snapshot
}

export function resetBatch(): void {
  const selected = snapshot.selected
  snapshot = { ...idle, selected }
  listeners.forEach((l) => l())
}

/** 页签消费“自然跑完”信号（只跳一次）。 */
export function ackBatchComplete(): void {
  if (snapshot.completed) setSnapshot({ completed: false })
}

export function setBatchSelection(selected: string[] | null): void {
  setSnapshot({ selected })
}

let cancelFlag = false

export function cancelBatch(): void {
  cancelFlag = true
}

function newBatchId(): string {
  try {
    const id = crypto.randomUUID()
    if (id) return id
  } catch {
    /* fallback below */
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * 判定调用失败退避重试（429/529/超时/断网最多 3 次，1s/2s/4s）；其余错误直接抛。
 * 四个场景（实况评估 / 法律断言 / 失败标签 / RAG 支撑）共用——判定接口失败时
 * 服务端回的是一条带 error 徽标的记录（HTTP 200），所以由场景适配器先把它抛出来，
 * 这里才接得住并退避重试；抛出同时让该条在汇总里记成失败，而不是假成功。
 */
async function withJudgeRetry<T>(call: () => Promise<T>): Promise<T> {
  let last: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await call()
    } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt >= 2 || !/429|529|50[023]|timeout|network|fetch|ECONN|ETIMEDOUT/i.test(msg)) throw e
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  throw last
}

/** 判定记录带 error 徽标 = 这条判定失败：抛出来让本条记失败并进入退避重试。 */
function throwIfJudgeFailed(result: { source: string; error?: string | null }): void {
  if (result.source === 'error') throw new Error(result.error || 'Jev 判定失败')
}

/** 选中题目的调用总数：每题两档答案各 3 遍，trap 题追加去注入对照轮。 */
export function countUnits(tasks: PlaygroundTaskList['tasks']): number {
  return tasks.reduce((n, t) => n + 2 * 3 + (t.injectionTrap ? 2 * 3 : 0), 0)
}

/** 一键全测场景适配：任务列表 + 取答案 + 单次判定 + 对照轮判定。 */
export interface BatchScenario {
  id: 'playground' | 'p0a-assertions' | 'p1c-tags' | 'p1e-rag'
  tasks: Array<{ id: string; title: string; domain: string }>
  sample: (taskId: string, kind: 'good' | 'bad') => Promise<string>
  judge: (
    taskId: string,
    answer: string,
    kind: 'good' | 'bad',
    batchId: string,
    clean: boolean,
  ) => Promise<{ choice: string | null; consistency: string | null; success: boolean | null }>
  cleanRoundsFor: (taskId: string) => boolean
  countUnits: (ids: string[]) => number
}

export function playgroundScenario(tasks: PlaygroundTaskList['tasks']): BatchScenario {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  return {
    id: 'playground',
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, domain: t.domain })),
    sample: async (taskId, kind) => (await api.pgSample(taskId, kind)).answer,
    judge: async (taskId, answer, kind, batchId, clean) => {
      // 校验必须在重试壳里面：判定接口失败回的是 HTTP 200 + error 徽标，抛出来才进得去退避重试。
      const jr = await withJudgeRetry(async () => {
        const res = await api.pgJevJudge(taskId, answer, { batchId, kind, ...(clean ? { clean: true } : {}) })
        throwIfJudgeFailed(res)
        return res
      })
      // 确定性判分只作证据（failureTags / 检查明细），通过与分数一律取判定模型的读数。
      return { choice: jr.choice?.choice ?? null, consistency: jr.consistency, success: jr.success ?? null }
    },
    cleanRoundsFor: (taskId) => !!byId.get(taskId)?.injectionTrap,
    countUnits: (ids) => countUnits(tasks.filter((t) => ids.includes(t.id))),
  }
}

export interface AssertionEntry {
  id: string
  dossierId: string
  assertionId: string
  goodAnswer: string
  badAnswer: string
}

export interface TagEntry {
  id: string
  scenarioId: string
  branch: string
  step: number
  text: string
}

export interface RagEntry {
  id: string
  query: string
  goodAnswer: string
  badAnswer: string
}

export function assertionScenario(entries: AssertionEntry[]): BatchScenario {
  const byId = new Map(entries.map((e) => [e.id, e]))
  return {
    id: 'p0a-assertions',
    tasks: entries.map((e) => ({ id: e.id, title: e.goodAnswer.length > 64 ? `${e.goodAnswer.slice(0, 64)}…` : e.goodAnswer, domain: 'legal' })),
    sample: async (taskId, kind) => {
      const e = byId.get(taskId)
      if (!e) throw new Error(`assertion not found: ${taskId}`)
      return kind === 'bad' ? e.badAnswer : e.goodAnswer
    },
    judge: async (taskId, answer, kind, batchId) => {
      const r = await withJudgeRetry(async () => {
        const rec = await api.pgAssertionJudge(taskId, kind, batchId)
        throwIfJudgeFailed(rec.result)
        return rec
      })
      void answer
      return { choice: r.result.choice?.choice ?? null, consistency: r.result.consistency, success: r.result.success ?? null }
    },
    cleanRoundsFor: () => false,
    countUnits: (ids) => ids.length * 2 * 3,
  }
}

export function tagScenario(entries: TagEntry[]): BatchScenario {
  const byId = new Map(entries.map((e) => [e.id, e]))
  return {
    id: 'p1c-tags',
    tasks: entries.map((e) => ({ id: e.id, title: e.text.length > 64 ? `${e.text.slice(0, 64)}…` : e.text, domain: e.scenarioId })),
    sample: async (taskId) => {
      const e = byId.get(taskId)
      if (!e) throw new Error(`tag task not found: ${taskId}`)
      return e.text
    },
    judge: async (taskId, _answer, kind, batchId) => {
      const r = await withJudgeRetry(async () => {
        const rec = await api.pgTagJudge(taskId, kind, batchId)
        throwIfJudgeFailed(rec.result)
        return rec
      })
      return { choice: r.result.choice?.choice ?? null, consistency: r.result.consistency, success: r.result.success ?? null }
    },
    cleanRoundsFor: () => false,
    countUnits: (ids) => ids.length * 2 * 3,
  }
}

export function ragScenario(entries: RagEntry[]): BatchScenario {
  const byId = new Map(entries.map((e) => [e.id, e]))
  return {
    id: 'p1e-rag',
    tasks: entries.map((e) => ({ id: e.id, title: e.query.length > 64 ? `${e.query.slice(0, 64)}…` : e.query, domain: 'legal' })),
    sample: async (taskId, kind) => {
      const e = byId.get(taskId)
      if (!e) throw new Error(`rag task not found: ${taskId}`)
      return kind === 'bad' ? e.badAnswer : e.goodAnswer
    },
    judge: async (taskId, _answer, kind, batchId) => {
      const r = await withJudgeRetry(async () => {
        const rec = await api.pgRagJudge(taskId, kind, batchId)
        throwIfJudgeFailed(rec.result)
        return rec
      })
      return { choice: r.result.choice?.choice ?? null, consistency: r.result.consistency, success: r.result.success ?? null }
    },
    cleanRoundsFor: () => false,
    countUnits: (ids) => ids.length * 2 * 3,
  }
}

export async function startBatch(scenarios: BatchScenario[], jevEnabled: boolean): Promise<void> {
  if (snapshot.running || !jevEnabled) return
  const pickedByScenario = scenarios
    .map((s) => ({
      s,
      picked: snapshot.selected == null ? s.tasks : s.tasks.filter((t) => snapshot.selected!.includes(t.id)),
    }))
    .filter((x) => x.picked.length > 0)
  if (pickedByScenario.length === 0) return
  cancelFlag = false
  const batchId = newBatchId()
  const total = pickedByScenario.reduce((n, x) => n + x.s.countUnits(x.picked.map((t) => t.id)), 0)
  setSnapshot({ running: true, done: 0, total, current: null, results: [], batchId })
  const answers = new Map<string, string>()
  const acc: BatchUnitResult[] = []
  let n = 0
  let cancelled = false

  const runOne = async (
    scenario: BatchScenario,
    taskId: string,
    kind: 'good' | 'bad',
    round: number,
    variant: 'clean' | null,
  ): Promise<void> => {
    setSnapshot({ current: { taskId, kind, round, variant } })
    try {
      const key = `${scenario.id}:${taskId}:${kind}`
      let answer = answers.get(key)
      if (answer === undefined) {
        answer = await scenario.sample(taskId, kind)
        answers.set(key, answer)
      }
      const jr = await scenario.judge(taskId, answer, kind, batchId, variant === 'clean')
      acc.push({
        taskId,
        kind,
        round,
        variant,
        ok: true,
        choice: jr.choice,
        consistent: jr.consistency,
        success: jr.success,
      })
    } catch (e) {
      acc.push({ taskId, kind, round, variant, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
    n++
    setSnapshot({ done: n, results: [...acc] })
  }

  for (const { s, picked } of pickedByScenario) {
    for (const task of picked) {
      for (const kind of ['good', 'bad'] as const) {
        for (let round = 1; round <= 3; round++) {
          if (cancelFlag) {
            cancelled = true
            break
          }
          await runOne(s, task.id, kind, round, null)
        }
        if (cancelled) break
        if (s.cleanRoundsFor(task.id)) {
          for (let round = 1; round <= 3; round++) {
            if (cancelFlag) {
              cancelled = true
              break
            }
            await runOne(s, task.id, kind, round, 'clean')
          }
        }
        if (cancelled) break
      }
      if (cancelled) break
    }
    if (cancelled) break
  }
  setSnapshot({ running: false, current: null, completed: !cancelled })
}

