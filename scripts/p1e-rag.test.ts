// P1-E RAG groundedness 集与判定管线单测（C 页签）：不断网。
// 覆盖：数据集 schema（16 条、thin 已剔除、证据冻结、好坏成对、坏档原因齐备且不泄露进答案）、
// 问题形状（单 Choice：grounded/ungrounded＋unclear 出口）、
// verdict 映射（一致/分歧/不可比）与 state 双 cap。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  RAG_QUESTION_IDS,
  buildRagQuestions,
  buildRagState,
  getRagTask,
  loadRagSet,
  normalizeRagChoice,
  ragAgreement,
} from '../server/playground/ragJudge'

test('rag set holds 16 grounded pairs with frozen passages and varied fabrications', () => {
  const tasks = loadRagSet()
  assert.equal(tasks.length, 16)
  assert.equal(new Set(tasks.map((t) => t.id)).size, 16)
  for (const t of tasks) {
    assert.equal(t.goldGood, 'grounded')
    assert.equal(t.goldBad, 'ungrounded')
    assert.ok(t.query, `${t.id} query`)
    assert.ok(t.passage && t.passage.length > 20, `${t.id} frozen passage`)
    assert.ok(t.goodAnswer && t.badAnswer && t.goodAnswer !== t.badAnswer, `${t.id} answers`)
    assert.ok(t.goldBadWhy, `${t.id} goldBadWhy`)
    assert.ok(t.queryId, `${t.id} queryId`)
    // 金标原因不得泄露进待判答案（否则判定可背答案）。
    assert.ok(!t.goodAnswer.includes(t.goldBadWhy), `${t.id} good leaks gold`)
    assert.ok(!t.badAnswer.includes(t.goldBadWhy), `${t.id} bad leaks gold`)
  }
  // thin 组（gs-aeabccf9）必须已剔除。
  assert.ok(!tasks.some((t) => t.queryId === 'gs-aeabccf9'), 'thin group excluded')
  assert.ok(getRagTask('G1')?.passage)
  assert.equal(getRagTask('zzz'), undefined)
})

test('rag question is a single Choice over grounded/ungrounded plus unclear', () => {
  const q = buildRagQuestions()
  assert.deepEqual(Object.keys(q), [RAG_QUESTION_IDS.cls])
  const cls = q[RAG_QUESTION_IDS.cls]
  assert.equal(cls.type, 'choice')
  if (cls.type === 'choice') {
    assert.ok('grounded' in cls.criteria, 'missing grounded')
    assert.ok('ungrounded' in cls.criteria, 'missing ungrounded')
    assert.ok('unclear' in cls.criteria, 'abstain outlet')
  }
})

test('rag verdict mapping: match, mismatch, abstain, garbage', () => {
  assert.equal(ragAgreement('grounded', 'grounded'), 'consistent')
  assert.equal(ragAgreement('ungrounded', 'grounded'), 'divergent')
  assert.equal(ragAgreement('unclear', 'grounded'), 'incomparable')
  assert.equal(ragAgreement(null, 'grounded'), 'incomparable')
  assert.equal(normalizeRagChoice('Grounded'), 'grounded')
  assert.equal(normalizeRagChoice('???'), 'unclear')
})

test('rag state carries frozen passage with dual caps', () => {
  const task = loadRagSet()[0]!
  const built = buildRagState(task, task.goodAnswer)
  assert.ok(built.state.includes(task.passage.slice(0, 20)), 'passage frozen into state')
  assert.ok(built.state.includes(task.goodAnswer.slice(0, 20)), 'answer in state')
  assert.ok(built.chars <= 64_000, 'char cap')
  assert.equal(built.truncated, false)
})
