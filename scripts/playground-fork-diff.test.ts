// PRD F2-7（同任务双配置逐步轨迹分叉 diff）的验收口径：
//   AC② 分叉前步骤一一对齐、首个差异步被明确标出
//   AC③ 差异高亮到字段级（调用工具不同 / 观测不同 / 裁决不同）
// 以及「分叉点之后允许逐步对比两条路径如何走向不同终局」。
//
// 这组用例锁的是真实现场形状：一条配置一口气作答、另一条读四个文件分六步。旧面板
// 按位置硬凑行，空的一侧塞 (no such step)，把「1 步 vs 6 步」这个真发现糊成了噪音。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildForkDiff, stepFields } from '../src/screens/Playground/forkDiff'
import { event as eventSchema } from '../shared/events'
import type { HarnessEvent } from '../shared/events'

let seq = 0
/** Fixtures go through the real event schema, so a malformed one fails loudly here. */
function ev(e: Record<string, unknown>): HarnessEvent {
  seq += 1
  return eventSchema.parse({ ...e, id: `e${seq}`, ts: 0, runId: 'r', scenarioId: 's', author: 'harness' })
}

/** C0 的形状：一口气作答，没有任何工具调用，答案被标 weak-grounding。 */
const c0: HarnessEvent[] = [
  ev({ type: 'run.started', model: 'm', task: 'G1' }),
  ev({ type: 'model.request', step: 1, blocks: [], estTokens: 10 }),
  ev({ type: 'model.response', step: 1, thought: '案情摘要 …', stopReason: 'stop' }),
  ev({ type: 'failure.tag', step: 1, mast: 'weak-grounding', confidence: 0.95, note: 'x' }),
  ev({ type: 'run.finished', success: false, tokens: 10, latencyP50: 1, failureModes: { 'weak-grounding': 1 } }),
]

/** C1 的形状：先列工作区、再逐个读 4 个文件，第 6 步才作答，无失败标签。 */
const c1: HarnessEvent[] = [
  ev({ type: 'run.started', model: 'm', task: 'G1' }),
  ev({ type: 'model.request', step: 1, blocks: [], estTokens: 10 }),
  ev({ type: 'model.response', step: 1, thought: '', stopReason: 'tool' }),
  ev({ type: 'router.decision', step: 1, tool: 'fs_list', route: 'EXECUTE', matchedRule: 'r', policyVersion: 'v' }),
  ev({ type: 'tool.call', step: 1, tool: 'fs_list', argsSummary: '' }),
  ev({ type: 'tool.result', step: 1, tool: 'fs_list', tokens: 5, summary: '工作区 5 个文件' }),
  ...[2, 3, 4, 5].map((s) =>
    ev({ type: 'tool.call', step: s, tool: 'fs_read', argsSummary: `dossier/${s}.pdf` }),
  ),
  ev({ type: 'tool.result', step: 5, tool: 'fs_read', tokens: 7, summary: '读取 dossier/修改后权利要求书.pdf' }),
  ev({ type: 'model.response', step: 6, thought: '案情摘要 …', stopReason: 'stop' }),
  ev({ type: 'run.finished', success: true, tokens: 40, latencyP50: 2, failureModes: {} }),
]

test('AC③ 字段桶把裁决类事件算成 decision —— router 与 verifier 都在内', () => {
  const f = stepFields(c1).get(1)!
  assert.deepEqual(f.tools, ['fs_list'])
  assert.deepEqual(f.observations, ['fs_list: 工作区 5 个文件'])
  assert.ok(f.decisions.some((d) => d.includes('router')), 'router.decision must land in decisions')
})

test('AC③ permission.denied 与 hook.decision 也算裁决，且不被冒充成同一类', () => {
  const f = stepFields([
    ev({ type: 'permission.denied', step: 1, scope: 'fs_write', riskLevel: 'high', gate: 'g', reason: 'r' }),
    ev({ type: 'hook.decision', step: 1, hook: 'h', verdict: 'allow', reason: 'ok' }),
  ]).get(1)!
  assert.ok(f.decisions.some((d) => d.includes('DENIED')))
  assert.ok(f.decisions.some((d) => d.startsWith('hook ')))
})

test('AC② 首个差异步被标为分叉点，不是序号巧合', () => {
  const d = buildForkDiff(c0, c1)
  assert.equal(d.forkAt, 1)
  assert.equal(d.rows.find((r) => r.fork)?.n, 1)
  assert.equal(d.rows.filter((r) => r.fork).length, 1, 'exactly one fork row')
})

test('AC③ 差异落到字段级：工具 / 观测 / 裁决 / 失败标签各自点名', () => {
  const row = buildForkDiff(c0, c1).rows[0]!
  assert.ok(row.diff.includes('tool'), 'A 没有工具、B 有')
  assert.ok(row.diff.includes('observation'), 'A 没有观测、B 有')
  assert.ok(row.diff.includes('decision'), 'A 没有裁决、B 有 router')
  assert.ok(row.diff.includes('tag'), 'A 有 weak-grounding、B 没有')
})

test('分叉点之后两条路径分开列，各带自己的步号 —— 不再用假行凑', () => {
  const d = buildForkDiff(c0, c1)
  assert.deepEqual(d.tailA.map((s) => s.n), [], 'C0 在分叉点就结束了')
  assert.deepEqual(d.tailB.map((s) => s.n), [2, 3, 4, 5, 6])
  assert.equal(
    d.rows.some((r) => JSON.stringify(r).includes('no such step')),
    false,
    '假行不得再出现',
  )
})

test('步数差被当成结论摆出来，而不是靠版面表达', () => {
  const d = buildForkDiff(c0, c1)
  assert.equal(d.stepsA, 1)
  assert.equal(d.stepsB, 6)
})

test('两条轨迹完全一致 → 无分叉点，全部对齐，没有尾段', () => {
  const d = buildForkDiff(c1, c1)
  assert.equal(d.forkAt, null)
  assert.equal(d.rows.length, 6)
  assert.deepEqual(d.tailA, [])
  assert.deepEqual(d.tailB, [])
  assert.ok(d.rows.every((r) => r.diff.length === 0))
})

test('分叉之前步骤一一对齐，差异只从分叉点往后出现', () => {
  // 两侧前三步完全一样，第四步起 C1 改用工具。
  const shared = [1, 2, 3].map((s) =>
    ev({ type: 'model.response', step: s, thought: `想 ${s}`, stopReason: 'stop' }),
  )
  const a = [...shared, ev({ type: 'model.response', step: 4, thought: 'A 的第四步', stopReason: 'stop' })]
  const b = [
    ...shared,
    ev({ type: 'model.request', step: 4, blocks: [], estTokens: 1 }),
    ev({ type: 'tool.call', step: 4, tool: 'fs_read', argsSummary: 'x' }),
  ]
  const d = buildForkDiff(a, b)
  assert.equal(d.forkAt, 4)
  assert.deepEqual(d.rows.map((r) => r.n), [1, 2, 3, 4])
  assert.deepEqual(d.rows.slice(0, 3).map((r) => r.diff.length), [0, 0, 0])
})

test('两侧都没有 thought 时，thought 的空值不算差异', () => {
  const a = [ev({ type: 'tool.call', step: 1, tool: 'fs_list', argsSummary: '' })]
  const b = [ev({ type: 'tool.call', step: 1, tool: 'fs_list', argsSummary: '' })]
  assert.equal(buildForkDiff(a, b).forkAt, null)
})

test('两侧连一个同号步骤都没有 → 明说无法对齐，两条路径各自整段列出', () => {
  const a = [ev({ type: 'model.response', step: 7, thought: 'A', stopReason: 'stop' })]
  const b = [ev({ type: 'model.response', step: 2, thought: 'B', stopReason: 'stop' })]
  const d = buildForkDiff(a, b)
  assert.equal(d.noCommonPrefix, true)
  assert.equal(d.rows.length, 0)
  assert.deepEqual(d.tailA.map((s) => s.n), [7])
  assert.deepEqual(d.tailB.map((s) => s.n), [2])
})

test('一侧没有轨迹 → 诚实空态，不用另一侧凑出一张对齐表', () => {
  const d = buildForkDiff([], c1)
  assert.equal(d.emptyA, true)
  assert.equal(d.emptyB, false)
  assert.deepEqual(d.rows, [])
})