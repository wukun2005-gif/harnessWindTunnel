// P0-A 法律断言集与判定管线单测（M1 场景扩展）：不断网。
// 覆盖：断言集 schema（26 条、五类全覆盖、好坏成对、坏档原因齐备）、
// 问题形状（Choice 为五类＋unclear 出口、Score 有序数组、Noul 在场）、
// verdict 映射（一致/分歧/不可比）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LEGAL_ASSERTIONS } from '../shared/legal'
import {
  ASSERTION_QUESTION_IDS,
  assertionAgreement,
  buildAssertionQuestions,
  buildAssertionState,
  getAssertionTask,
  loadAssertionSet,
} from '../server/playground/assertionJudge'

test('assertion set holds 26 paired items with full five-class coverage', () => {
  const tasks = loadAssertionSet()
  assert.equal(tasks.length, 26)
  assert.equal(new Set(tasks.map((t) => t.id)).size, 26)
  const valid = new Set<string>(LEGAL_ASSERTIONS as readonly string[])
  const goodLabels = new Set<string>()
  for (const t of tasks) {
    assert.ok(valid.has(t.goldGood), `${t.id} goldGood`)
    assert.ok(valid.has(t.goldBad), `${t.id} goldBad`)
    goodLabels.add(t.goldGood)
    assert.ok(t.goodAnswer && t.badAnswer && t.goodAnswer !== t.badAnswer, `${t.id} answers`)
    assert.ok(t.goldBadWhy, `${t.id} goldBadWhy`)
    assert.ok(t.dossierId && t.assertionId, `${t.id} refs`)
    assert.ok(t.assertionText, `${t.id} assertionText joined from dossier正典`)
    assert.ok(t.authority, `${t.id} authority joined from dossier正典`)
  }
  for (const label of valid) assert.ok(goodLabels.has(label), `missing label ${label}`)
  assert.ok(getAssertionTask('A1')?.dossierId)
  assert.equal(getAssertionTask('zzz'), undefined)
})

test('assertion questions follow the research shape', () => {
  const q = buildAssertionQuestions()
  assert.deepEqual(Object.keys(q).sort(), Object.values(ASSERTION_QUESTION_IDS).sort())
  const cls = q[ASSERTION_QUESTION_IDS.cls]
  assert.equal(cls.type, 'choice')
  if (cls.type === 'choice') {
    for (const label of LEGAL_ASSERTIONS) assert.ok(label in cls.criteria, `missing ${label}`)
    assert.ok('unclear' in cls.criteria, 'abstain outlet')
  }
  const score = q[ASSERTION_QUESTION_IDS.support]
  assert.equal(score.type, 'score')
  if (score.type === 'score') assert.ok(score.criteria.length >= 2)
  assert.equal(q[ASSERTION_QUESTION_IDS.reachable].type, 'noul')
})

test('assertion verdict mapping: match, mismatch, abstain', () => {
  assert.equal(assertionAgreement('supported', 'supported'), 'consistent')
  assert.equal(assertionAgreement('none', 'supported'), 'divergent')
  assert.equal(assertionAgreement('unclear', 'supported'), 'incomparable')
  assert.equal(assertionAgreement(null, 'supported'), 'incomparable')
})

test('assertion state carries the assertion (claim side of claim-vs-source)', () => {
  const t = getAssertionTask('A25')!
  const built = buildAssertionState(t, t.goodAnswer)
  assert.ok(built.state.includes('【断言】'), '断言必须进 state')
  assert.ok(built.state.includes(t.assertionText), 'state 用正典断言原文')
  assert.ok(built.state.includes('【案卷登记的权威依据】'), '权威依据必须进 state')
  assert.ok(built.state.includes(t.authority), 'state 用正典权威依据原文')
  assert.ok(built.state.includes('<<<CANDIDATE_ANSWER'), '候选回答仍标记为数据')
  assert.equal(built.truncated, false)
  // 泄题红线：金标与理由不进判定材料。
  assert.ok(!built.state.includes(t.goldGood), 'gold label 不进 state')
  assert.ok(!built.state.includes(t.goldBadWhy), 'goldWhy 不进 state')
})

test('gold≠no_citation answers carry explicit citations; no_citation answers stay bare', () => {
  // 方案1 钉死：凡金标需要引用在场（supported/partially/unsupported/unreachable），
  // 答案必须带显式引用标记；金标 no_citation 的答案必须保持裸文本（不然判不出无引用）。
  const CITATION_RE = /(see\s|Rules?\s+\d|Opinion\s+\d|Section\s+\d|v\.\s)/i
  for (const t of loadAssertionSet()) {
    assert.equal(CITATION_RE.test(t.goodAnswer), t.goldGood !== 'no_citation', `${t.id} goodAnswer citation marker`)
    assert.equal(CITATION_RE.test(t.badAnswer), t.goldBad !== 'no_citation', `${t.id} badAnswer citation marker`)
  }
})

test('gold reflects ground-truth calibration (reachability-first dual-defect and holiday-window cases)', () => {
  // 金标校准钉（最高优先级修正）：双缺陷题按可达性先判门归引用不可达；
  // 假日扣除后截止日 3/15、3/14 提交在期限内 → 主张为真判已支撑。
  assert.equal(getAssertionTask('A2')?.goldGood, 'citation_unreachable')
  assert.equal(getAssertionTask('A4')?.goldGood, 'citation_unreachable')
  assert.equal(getAssertionTask('A6')?.goldGood, 'citation_unreachable')
  assert.equal(getAssertionTask('A13')?.goldGood, 'supported')
  assert.equal(getAssertionTask('A17')?.goldGood, 'partially_supported')
})

test('class criteria pin citation-counting and no-retrieval rules', () => {
  const q = buildAssertionQuestions()
  const cls = q[ASSERTION_QUESTION_IDS.cls]
  assert.equal(cls.type, 'choice')
  if (cls.type === 'choice') {
    assert.ok(String(cls.criteria.supported).includes('【断言】'), '支撑类以断言为对象')
    assert.ok(String(cls.criteria.supported).includes('纠正'), '纠正句切换判定对象')
    assert.ok(String(cls.criteria.no_citation).includes('条号'), '规则条号算引用')
    assert.ok(String(cls.criteria.no_citation).includes('否定式'), '否定式提及不算引用')
    assert.ok(String(cls.criteria.citation_unreachable).includes('不算引用'), '不可达类同受否定式条款约束')
    assert.ok(String(cls.criteria.citation_unreachable).includes('不做实际检索'), '可达性不做文本猜测')
    assert.ok(String(cls.criteria.citation_unreachable).includes('可达性先于支撑'), '双缺陷时可达性优先（金标 A2/A4/A6 口径）')
    assert.ok(String(cls.instructions).includes('不做实际检索'), '题面声明不检索边界')
  }
  const noul = q[ASSERTION_QUESTION_IDS.reachable]
  assert.equal(noul.type, 'noul')
  if (noul.type === 'noul') assert.ok(String(noul.instructions).includes('虚构'), 'Noul 同口径改判明显虚构')
})
