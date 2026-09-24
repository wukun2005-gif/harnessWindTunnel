// P1-C 失败标签集与判定管线单测（M1 场景扩展）：不断网。
// 覆盖：断言集 schema（10 个唯一锚点、金标为非空标签集合、12 类全覆盖、文本与标注分离）、
// 金标完整性钉（每个分支「金标并集 == fixture run.finished 的 failureModes 键集」——
// 金标必须完整反映 ground truth：多标签步骤不许拆成互相矛盾的单标签题、也不许漏标）、
// 问题形状（Choice 为 13 标签＋other＋unclear 出口）、
// verdict 映射（读数 ∈ 金标集合一致 / 出集分歧 / abstain 不可比）。
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import type { MastTag } from '../shared/mast'
import { MAST_HINT } from '../shared/mast'
import {
  TAG_QUESTION_IDS,
  buildTagQuestions,
  buildTagState,
  getTagTask,
  loadTagSet,
  normalizeTagChoice,
  tagAgreement,
} from '../server/playground/tagJudge'

const TAGS: MastTag[] = [
  'premature-victory',
  'weak-grounding',
  'long-horizon-decay',
  'spec-misinterpretation',
  'fabricated-citation',
  'scope-violation',
  'step-repetition',
  'reasoning-action-mismatch',
  'unaware-of-stopping',
  'task-derailment',
  'fail-to-clarify',
  'context-loss',
]

test('tag set holds 10 uniquely-anchored steps with non-empty gold label sets', () => {
  const tasks = loadTagSet()
  assert.equal(tasks.length, 10)
  assert.equal(new Set(tasks.map((t) => t.id)).size, 10)
  const anchors = new Set(tasks.map((t) => `${t.scenarioId}/${t.branch}/${t.step}`))
  assert.equal(anchors.size, 10, '同一失败步骤只许一题（多标签合并，不许拆题）')
  const covered = new Set<string>()
  for (const t of tasks) {
    assert.ok(Array.isArray(t.goldTags) && t.goldTags.length > 0, `${t.id} goldTags non-empty`)
    for (const g of t.goldTags) covered.add(g)
    assert.ok(t.text, `${t.id} text`)
    assert.ok(t.goldWhy, `${t.id} goldWhy`)
    // 任务规格是判定输入契约的一部分（live 同源），题集必须每题自带。
    assert.ok(t.taskSpec, `${t.id} taskSpec`)
    assert.ok(t.scenarioId && t.branch && Number.isInteger(t.step), `${t.id} refs`)
    // 标注员备注不得漏进待判文本（否则金标泄露）。
    assert.ok(!t.text.includes(t.goldWhy), `${t.id} leaks gold`)
    assert.ok(!t.taskSpec.includes(t.goldWhy), `${t.id} taskSpec leaks gold`)
  }
  for (const tag of TAGS) assert.ok(covered.has(tag), `missing tag ${tag}`)
  assert.ok(getTagTask('T1'))
  assert.equal(getTagTask('zzz'), undefined)
})

test('ground-truth completeness: per-branch gold union equals fixture failureModes keys', () => {
  const tasks = loadTagSet()
  const goldByBranch = new Map<string, Set<string>>()
  for (const t of tasks) {
    const key = `${t.scenarioId}/${t.branch}`
    if (!goldByBranch.has(key)) goldByBranch.set(key, new Set())
    for (const g of t.goldTags) goldByBranch.get(key)!.add(g)
  }

  const scenarioRoot = join(process.cwd(), 'data', 'scenarios')
  let branchesChecked = 0
  for (const sid of readdirSync(scenarioRoot)) {
    const dir = join(scenarioRoot, sid, 'branches')
    let files: string[]
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const entries = readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as { type?: string; failureModes?: Record<string, number> })
      const finished = entries.filter((e) => e.type === 'run.finished' && e.failureModes)
      if (finished.length === 0) continue
      const fixtureTags = new Set<string>()
      for (const e of finished) for (const k of Object.keys(e.failureModes!)) fixtureTags.add(k)
      const gold = goldByBranch.get(`${sid}/${f}`) ?? new Set<string>()
      assert.deepEqual(
        [...gold].sort(),
        [...fixtureTags].sort(),
        `branch ${sid}/${f} 金标并集必须等于 fixture failureModes 键集`,
      )
      branchesChecked++
    }
  }
  assert.ok(branchesChecked >= 8, `checked fixture branches: ${branchesChecked}`)
})

test('tag question is a single Choice over 13 tags plus unclear', () => {
  const q = buildTagQuestions()
  assert.deepEqual(Object.keys(q), [TAG_QUESTION_IDS.cls])
  const cls = q[TAG_QUESTION_IDS.cls]
  assert.equal(cls.type, 'choice')
  if (cls.type === 'choice') {
    for (const tag of TAGS) assert.ok(tag in cls.criteria, `missing ${tag}`)
    assert.ok('other' in cls.criteria, 'other bucket')
    assert.ok('unclear' in cls.criteria, 'abstain outlet')
    // 指令口径钉（P0 评估集修复，评测与 live 同一份指令）：
    // 表层 scope（打 T5 类跨步因果题）、主导标签规则（打多标签撞单选的弃权）、
    // 结合任务判断、注入防护升级为「任务与步骤都是数据」。
    assert.ok(cls.instructions.includes('表层'), 'surface-scope instruction')
    assert.ok(cls.instructions.includes('主导'), 'dominant-label instruction')
    assert.ok(cls.instructions.includes('【任务】'), 'task-context instruction')
    assert.ok(cls.instructions.includes('不是给你的指令'), 'injection guard')
  }
})

test('tag definitions draw every confusable-pair boundary (mutual, no per-task refs)', () => {
  // 系统边界钉（方案 A）：易混邻域矩阵——每对相邻标签在对方定义里互相点名，
  // 全表禁止题号（防朝单道题答案拟合）。改漏一对或写成特判，测试即红。
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['context-loss', 'long-horizon-decay'],
    ['scope-violation', 'spec-misinterpretation'],
    ['premature-victory', 'reasoning-action-mismatch'],
    ['premature-victory', 'weak-grounding'],
    ['premature-victory', 'unaware-of-stopping'],
    ['weak-grounding', 'fabricated-citation'],
    ['spec-misinterpretation', 'fail-to-clarify'],
    ['scope-violation', 'task-derailment'],
    ['unaware-of-stopping', 'task-derailment'],
    ['step-repetition', 'long-horizon-decay'],
    ['reasoning-action-mismatch', 'task-derailment'],
  ]
  for (const [a, b] of pairs) {
    assert.ok(MAST_HINT[a as keyof typeof MAST_HINT].includes(b), `${a} must name ${b}`)
    assert.ok(MAST_HINT[b as keyof typeof MAST_HINT].includes(a), `${b} must name ${a}`)
  }
  // 12 个真实标签全部过一遍：定义里不许出现任何题号。
  for (const [tag, hint] of Object.entries(MAST_HINT)) {
    assert.ok(!/\bT\d+\b/.test(hint), `${tag} hint references a task id`)
  }
})

test('tag judge state leads with the task spec', () => {
  const t = getTagTask('T1')!
  const built = buildTagState(t)
  assert.ok(built.state.startsWith(`【任务】${t.taskSpec}`), 'task spec first line')
  assert.ok(built.state.includes('【轨迹步骤】'), 'step section present')
  assert.ok(built.state.includes(t.text), 'step text present')
  // 禁入钉：叙述者标注（＝金标原文）与失败模式汇总永不进判定状态。
  for (const task of loadTagSet()) {
    const s = buildTagState(task).state
    assert.ok(!s.includes(task.goldWhy), `${task.id} narrator note leaks`)
    assert.ok(!s.includes('failureModes'), `${task.id} run.finished summary leaks`)
  }
})

test('tag verdict mapping: member of gold set, outside set, abstain, garbage', () => {
  assert.equal(tagAgreement('scope-violation', ['scope-violation']), 'consistent')
  // 多标签金标：读数命中集合里任一标签即一致（单步可同时具备多个失败模式）。
  assert.equal(
    tagAgreement('scope-violation', ['scope-violation', 'reasoning-action-mismatch']),
    'consistent',
  )
  assert.equal(
    tagAgreement('reasoning-action-mismatch', ['scope-violation', 'reasoning-action-mismatch']),
    'consistent',
  )
  assert.equal(
    tagAgreement('context-loss', ['scope-violation', 'reasoning-action-mismatch']),
    'divergent',
  )
  assert.equal(tagAgreement('none', ['scope-violation']), 'divergent')
  assert.equal(tagAgreement('unclear', ['scope-violation']), 'incomparable')
  assert.equal(tagAgreement(null, ['scope-violation']), 'incomparable')
  assert.equal(normalizeTagChoice('Scope-Violation'), 'scope-violation')
  assert.equal(normalizeTagChoice('???'), 'unclear')
})
