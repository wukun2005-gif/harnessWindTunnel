// Token 本地估算（CJK 上界口径）与 state 预算单测。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateTokens } from '../server/playground/tokens'
import { loadEvalSet } from '../server/playground/evalset'
import { buildJudgeState } from '../server/playground/jevJudge'

test('ascii counts half, cjk counts one (conservative upper bound)', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('abcd'), 2)
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('a中'), 2)
  // 纯英文比老口径（/2）大？不：'abcd' 老口径也是 2；中文老口径 1，现口径 2（修正方向）。
  assert.ok(estimateTokens('答'.repeat(100)) === 100)
})

test('huge cjk answers truncate within the 30k token budget, not just the char cap', () => {
  const tasks = loadEvalSet().tasks
  const general = tasks.find((t) => t.id === 'G1')!
  const built = buildJudgeState(general, '答'.repeat(80_000))
  assert.equal(built.truncated, true)
  assert.ok(built.state.includes('已按 state 预算截断'))
  assert.ok(estimateTokens(built.state) <= 30_000, `over budget: ${estimateTokens(built.state)}`)
  assert.ok(built.chars <= 64_400, `over char cap: ${built.chars}`)
})

test('small answers pass through untouched and unflagged', () => {
  const tasks = loadEvalSet().tasks
  const general = tasks.find((t) => t.id === 'G1')!
  const built = buildJudgeState(general, general.referenceAnswer)
  assert.equal(built.truncated, false)
  assert.ok(!built.state.includes('已按 state 预算截断'))
})
