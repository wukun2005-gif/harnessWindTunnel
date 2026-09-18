import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BOOTSTRAP_DRAWS,
  compatibilitySpread,
  fitRating,
  hashSeed,
  isFragile,
  kendallTau,
  liftStats,
  mean,
  mulberry32,
  pairedLifts,
  std,
} from '../shared/reliability'

test('pairedLifts computes element-wise diffs and rejects bad input', () => {
  assert.deepEqual(pairedLifts([50, 52], [44, 45]), [6, 7])
  assert.equal(pairedLifts([50], [44, 45]), null)
  assert.equal(pairedLifts([], []), null)
  assert.equal(pairedLifts([50, NaN], [44, 45]), null)
})

test('liftStats reports mean/max/worst/win-rate and a bounded conservative gain', () => {
  const s = liftStats([2, 3, 1, 4, 2, 3, 2, 5], 42)!
  assert.equal(s.n, 8)
  assert.equal(s.meanLift, 2.75)
  assert.equal(s.maxLift, 5)
  assert.equal(s.worstLift, 1)
  assert.equal(s.rr0, 1)
  assert.ok(Number.isFinite(s.relLift95))
  assert.ok(s.relLift95 >= s.worstLift && s.relLift95 <= s.meanLift)
  assert.equal(liftStats(null, 1), null)
  assert.equal(liftStats([], 1), null)
})

test('bootstrap is deterministic for the same seed and sensitive to it', () => {
  const lifts = [2, 3, 1, 4, 2, 3, 2, 5]
  assert.equal(liftStats(lifts, 7)!.relLift95, liftStats(lifts, 7)!.relLift95)
  assert.equal(BOOTSTRAP_DRAWS, 5000)
  const r1 = mulberry32(hashSeed('a'))
  const r2 = mulberry32(hashSeed('a'))
  assert.equal(r1(), r2())
  assert.notEqual(hashSeed('a'), hashSeed('b'))
})

test('isFragile flags positive means with negative worst or low win rate', () => {
  assert.equal(isFragile({ n: 8, meanLift: 4, maxLift: 6, worstLift: -0.1, rr0: 0.88, relLift95: 2 }), true)
  assert.equal(isFragile({ n: 8, meanLift: 4, maxLift: 6, worstLift: 1, rr0: 0.5, relLift95: 2 }), true)
  assert.equal(isFragile({ n: 8, meanLift: 14, maxLift: 16, worstLift: 11, rr0: 1, relLift95: 13 }), false)
  assert.equal(isFragile({ n: 8, meanLift: -7, maxLift: -5, worstLift: -11, rr0: 0, relLift95: -8 }), false)
})

test('fitRating follows the three-tier rule', () => {
  assert.equal(fitRating([2, 3, 1]), 'Recommended')
  assert.equal(fitRating([5, -1, 4]), 'Compatible')
  assert.equal(fitRating([-1, -2]), 'Caution')
  assert.equal(fitRating([]), null)
  assert.deepEqual(compatibilitySpread([70, 74, 72]), { range: 4, std: std([70, 74, 72]) })
  assert.equal(compatibilitySpread([]), null)
})

test('kendallTau spans perfect agreement to reversal', () => {
  assert.equal(kendallTau([1, 2, 3], [1, 2, 3]), 1)
  assert.equal(kendallTau([1, 2, 3], [3, 2, 1]), -1)
  assert.equal(kendallTau([1], [1]), null)
  assert.equal(kendallTau([1, 2], [1]), null)
})

test('mean/std basics', () => {
  assert.equal(mean([2, 4]), 3)
  assert.equal(std([5]), 0)
  assert.ok(Number.isNaN(mean([])))
})
