// ROUGE readings (server/playground/rouge.ts). These pin the two properties the
// keyword scorer lacks: tolerance for formatting/wording variation, and a score
// that degrades gradually instead of collapsing to zero.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadEvalSet } from '../server/playground/evalset'
import { charTokens, rougeAgainstReference } from '../server/playground/rouge'
import { makeBadAnswer } from '../server/playground/scorer'
import type { EvalTask } from '../shared/playground'

const tasks = loadEvalSet().tasks
const byId = new Map(tasks.map((t) => [t.id, t]))

test('charTokens keeps CJK, latin and digits; drops whitespace and punctuation', () => {
  assert.deepEqual(charTokens('相变材料，LED 散热。'), ['相', '变', '材', '料', 'L', 'E', 'D', '散', '热'])
  assert.deepEqual(charTokens('  \n\t '), [])
  assert.deepEqual(charTokens('2024年3月15日'), ['2', '0', '2', '4', '年', '3', '月', '1', '5', '日'])
})

test('an empty or unscorable answer reads as zero rather than throwing', () => {
  // js-rouge raises on an empty candidate; the scorer must still return a verdict
  // for a failed run's placeholder answer.
  const ref = byId.get('G1')!.referenceAnswer
  for (const empty of ['', '   \n\t ', '，。；：—']) {
    const r = rougeAgainstReference(empty, ref)
    assert.deepEqual([r.rouge1, r.rougeL, r.rouge1F, r.rougeLF], [0, 0, 0, 0], JSON.stringify(empty))
  }
})

test('the reference answer scores a perfect 1.0 against itself', () => {
  for (const t of tasks) {
    const r = rougeAgainstReference(t.referenceAnswer, t.referenceAnswer)
    assert.equal(r.rouge1, 1, `${t.id} rouge1`)
    assert.equal(r.rougeL, 1, `${t.id} rougeL`)
    assert.ok(r.referenceTokens > 0, `${t.id} referenceTokens`)
  }
})

test('a wrong answer scores far below a right one', () => {
  // Not a threshold — just the ordering the reading has to preserve.
  for (const id of ['G1', 'G3', 'L2', 'L12']) {
    const t = byId.get(id)!
    const right = rougeAgainstReference(t.referenceAnswer, t.referenceAnswer).rouge1
    const wrong = rougeAgainstReference(makeBadAnswer(t), t.referenceAnswer).rouge1
    assert.ok(right > wrong, `${id}: right ${right} should beat wrong ${wrong}`)
    assert.ok(wrong < 0.5, `${id}: a wrong answer scored ${wrong}`)
  }
})

// ── the property the keyword scorer fails ────────────────────────────────────
// G4's gold enumerates four date spellings. Writing the fifth — "2024年03月15日"
// — dropped the per-point score from 1.0 to 0.2, and "2024.03.15" to 0.0, for an
// answer whose content is identical. ROUGE must not care.

test('a date written a different way barely moves the score', () => {
  const g4 = byId.get('G4')!
  const base = rougeAgainstReference(g4.referenceAnswer, g4.referenceAnswer).rouge1
  assert.equal(base, 1)

  const zeroPadded = g4.referenceAnswer.replace(
    /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
    (_m, y: string, mo: string, dd: string) => `${y}年${mo.padStart(2, '0')}月${dd.padStart(2, '0')}日`,
  )
  const dotted = g4.referenceAnswer.replace(
    /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
    (_m, y: string, mo: string, dd: string) => `${y}.${mo.padStart(2, '0')}.${dd.padStart(2, '0')}`,
  )
  assert.notEqual(zeroPadded, g4.referenceAnswer, 'the rewrite must actually change the text')
  assert.notEqual(dotted, g4.referenceAnswer)

  for (const [label, text] of [['zero-padded', zeroPadded], ['dotted', dotted]] as const) {
    const r = rougeAgainstReference(text, g4.referenceAnswer)
    assert.ok(r.rouge1 > 0.9, `${label}: rouge1 ${r.rouge1} — formatting must not cost more than a few percent`)
    assert.ok(r.rougeL > 0.9, `${label}: rougeL ${r.rougeL}`)
  }
})

test('a longer answer is not punished for its length under the recall weighting', () => {
  const t = byId.get('L17') as EvalTask
  const padded = `${t.referenceAnswer}${'补充说明：本案还需结合卷宗整体情况综合判断，以下为详细展开。'.repeat(40)}`
  const short = rougeAgainstReference(t.referenceAnswer, t.referenceAnswer)
  const long = rougeAgainstReference(padded, t.referenceAnswer)

  assert.ok(long.rouge1 > 0.95, `recall-weighted reading should stay high, got ${long.rouge1}`)
  // The textbook β=1 F-score is the one that collapses on length — kept visible
  // so the difference is not mistaken for a bug.
  assert.ok(long.rouge1F < short.rouge1F, 'the β=1 reading is expected to fall with length')
})

test('a paraphrase that changes the wording stays far above a wrong answer', () => {
  // G9's conclusion, written without any of the words the gold group listed
  // ("印证|对应|一致|不符|差异|实际|表1") — the exact text the keyword scorer
  // marked as a missing point.
  const t = byId.get('G9')!
  const paraphrase =
    '复审请求书主张散热效率提高约35%、结温降低8-12°C。核对原说明书：实施例1结温78°C，对比例1结温90°C。' +
    '其中结温降幅能够从实验数据得到佐证；但散热效率提升这一比例值，在原说明书中找不到支撑。'
  const r = rougeAgainstReference(paraphrase, t.referenceAnswer)
  const wrong = rougeAgainstReference(makeBadAnswer(t), t.referenceAnswer)

  // Asserted as a ratio, not an absolute floor: the paraphrase is a 101-character
  // excerpt of a 255-character reference, so it legitimately recalls only part of
  // it. What matters is that it separates cleanly from a wrong answer.
  assert.ok(r.rouge1 > 3 * wrong.rouge1, `rouge1 ${r.rouge1} vs wrong ${wrong.rouge1}`)
  assert.ok(r.rouge1 > 0.3, `rouge1 ${r.rouge1}`)
})
