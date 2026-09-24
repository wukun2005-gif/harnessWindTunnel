import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadEvalSet } from '../server/playground/evalset'
import { scoreAnswer, makeBadAnswer } from '../server/playground/scorer'
import { locateArticle, resetLawDocCache } from '../server/playground/articles'
import type { EvalTask } from '../shared/playground'

resetLawDocCache()
const list = loadEvalSet()
const tasks = list.tasks
const byId = new Map(tasks.map((t) => [t.id, t]))

test('eval set has 45 tasks with unique ids', () => {
  assert.equal(tasks.length, 45)
  assert.equal(new Set(tasks.map((t) => t.id)).size, 45)
})

test('domain counts are 通用15 / 法律21 / 安全9', () => {
  const n = (d: string) => tasks.filter((t) => t.domain === d).length
  assert.equal(n('general'), 15)
  assert.equal(n('legal'), 21)
  assert.equal(n('security'), 9)
})

test('split counts are repair21 / gate15 / scorecard9 and disjoint', () => {
  const n = (s: string) => tasks.filter((t) => t.split === s).length
  assert.equal(n('repair'), 21)
  assert.equal(n('gate'), 15)
  assert.equal(n('scorecard'), 9)
})

test('the 9 signature tasks exist and sit in repair', () => {
  for (const id of ['G1', 'G2', 'G3', 'L1', 'L2', 'L3', 'S1', 'S2', 'S3']) {
    const t = byId.get(id)
    assert.ok(t, `missing ${id}`)
    assert.equal(t!.signature, true)
    assert.equal(t!.split, 'repair')
  }
})

test('every reference answer scores success (gold self-consistency)', () => {
  const fails: string[] = []
  for (const t of tasks) {
    const r = scoreAnswer(t, t.referenceAnswer)
    if (!r.success) fails.push(`${t.id}: ${r.summary}`)
  }
  assert.deepEqual(fails, [], fails.join('\n'))
})

test('every expected article locates in the KB and contains its articleKeywords', () => {
  const problems: string[] = []
  for (const t of tasks) {
    for (const exp of t.expectedArticles ?? []) {
      const loc = locateArticle({ law: exp.law, article: exp.article, clause: exp.clause, section: exp.section })
      if (!loc) {
        problems.push(`${t.id}/${exp.id}: cannot locate ${exp.label}`)
        continue
      }
      for (const kw of exp.articleKeywords) {
        const variants = kw.split('|').map((x) => x.trim())
        const anyHit = variants.some((v) => loc.text.includes(v))
        if (!anyHit) problems.push(`${t.id}/${exp.id}: statute text missing keyword「${kw}」`)
      }
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'))
})

test('signature bad answers all fail', () => {
  for (const id of ['G1', 'G2', 'G3', 'L1', 'L2', 'L3', 'S1', 'S2', 'S3']) {
    const t = byId.get(id)!
    const r = scoreAnswer(t, makeBadAnswer(t))
    assert.equal(r.success, false, `${id} bad answer should fail`)
  }
})

test('anti-hallucination: fabricated citations are rejected, real answers recognized', () => {
  for (const id of ['L3', 'L20']) {
    const t = byId.get(id)!
    assert.ok(t.antiHallucination)
    const good = scoreAnswer(t, t.referenceAnswer)
    assert.equal(good.antiHallucination?.recognized, true, `${id} reference should recognize fake citation`)
    assert.equal(good.success, true)
    const bad = scoreAnswer(t, makeBadAnswer(t))
    assert.equal(bad.success, false, `${id} fabricated answer should fail`)
    assert.ok(bad.failureTags.includes('fabricated-citation'))
  }
})

test('leak: sensitive values in the answer fail; redacted reference passes', () => {
  const s3 = byId.get('S3')!
  const leak = scoreAnswer(s3, makeBadAnswer(s3))
  assert.equal(leak.success, false)
  assert.ok(leak.securityChecks.some((c) => c.kind === 'leak' && !c.passed))
  assert.ok(leak.failureTags.includes('scope-violation'))
  const clean = scoreAnswer(s3, s3.referenceAnswer)
  assert.equal(clean.success, true)

  const s6 = byId.get('S6')!
  assert.equal(scoreAnswer(s6, makeBadAnswer(s6)).success, false)
})

test('injection: obeying the injected instruction fails; resisting passes', () => {
  for (const id of ['S1', 'S4']) {
    const t = byId.get(id)!
    const obeyed = scoreAnswer(t, makeBadAnswer(t))
    assert.equal(obeyed.success, false, `${id} obeyed injection should fail`)
    assert.ok(obeyed.failureTags.includes('scope-violation'))
    assert.equal(scoreAnswer(t, t.referenceAnswer).success, true, `${id} resisting answer should pass`)
  }
})

test('overreach: granting internal records fails; deny-first passes', () => {
  for (const id of ['S2', 'S5']) {
    const t = byId.get(id)!
    assert.equal(scoreAnswer(t, makeBadAnswer(t)).success, false, `${id} granted overreach should fail`)
    assert.equal(scoreAnswer(t, t.referenceAnswer).success, true, `${id} deny-first should pass`)
  }
})

test('benign controls: over-refusal fails; a normal answer passes', () => {
  for (const id of ['S7', 'S8', 'S9']) {
    const t = byId.get(id)!
    assert.equal(t.benign, true)
    const refused = scoreAnswer(t, makeBadAnswer(t))
    assert.equal(refused.success, false, `${id} over-refusal should fail`)
    assert.ok(refused.failureTags.includes('spec-misinterpretation'))
    assert.equal(scoreAnswer(t, t.referenceAnswer).success, true, `${id} normal answer should pass`)
  }
})

test('empty answer always fails', () => {
  for (const t of tasks) {
    assert.equal(scoreAnswer(t, '').success, false, `${t.id} empty answer should fail`)
  }
})

test('legal reference answers cite the expected statute (not just talk about it)', () => {
  // spot-check the high-value citations
  const spot: Array<[string, string, number]> = [
    ['L1', 'patent-law', 22],
    ['L12', 'patent-law', 41],
    ['L13', 'implementing-regulations', 6],
    ['L17', 'infringement-interp-1', 7],
    ['L18', 'patent-disputes-rules', 13],
    ['L19', 'infringement-interp-1', 6],
  ]
  for (const [id, law, art] of spot) {
    const t = byId.get(id)!
    const r = scoreAnswer(t, t.referenceAnswer)
    const c = r.articleChecks.find((x) => x.law === law && Number(x.article) === art)
    assert.ok(c, `${id} missing check for ${law} ${art}`)
    assert.equal(c!.assertion, 'supported', `${id} ${law} ${art} → ${c!.assertion}`)
  }
})
