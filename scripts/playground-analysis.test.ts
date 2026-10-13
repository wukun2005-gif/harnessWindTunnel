// 实测分析纯计算（M1 §17.9）单测：一致率 / 漂移率 / 校准桶 / 成本 / 总建议。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { JevReviewRecord } from '../shared/jev'
import {
  agreementBySource,
  agreementStats,
  calibrationBuckets,
  calibrationConservative,
  calibrationStatus,
  confidenceStats,
  costStats,
  driftStats,
  injectionStats,
  overallVerdict,
  sourceDist,
  trapStats,
} from '../src/screens/Playground/analysis'
let n = 0
function rec(partial: Omit<Partial<JevReviewRecord>, 'result'> & { result?: object }): JevReviewRecord {
  n++
  const base = {
    taskId: 'G1',
    domain: 'general',
    source: 'decided',
    reason: '',
    enabled: true,
    model: 'jev-latest',
    choice: { choice: 'none', probabilities: null, confidence: 0.9 },
    agreement: { score: 1, probabilities: null, confidence: 0.9 },
    grounded: null,
    consistency: 'consistent',
    consistencyDetail: '',
    success: false,
    score: 0,
    stateChars: 100,
    estimatedPromptTokens: 50,
    usage: null,
    stateSharesInjectedPayload: false,
    stateTruncated: false,
    latencyMs: 800,
    error: null,
  }
  const { result: rOverride, ...rest } = partial
  return {
    id: `t${n}`,
    time: '2026-09-22T00:00:00.000Z',
    batchId: 'b1',
    kind: 'good',
    taskId: 'G1',
    domain: 'general',
    split: 'repair',
    scorerType: 'field-match',
    answer: 'a',
    detSuccess: false,
    detScore: 0,
    threshold: 0.9,
    cascadeEnabled: true,
    ...rest,
    result: { ...base, ...(rOverride ?? {}) } as unknown as JevReviewRecord['result'],
  } as unknown as JevReviewRecord
}

test('agreement counts consistent over judged, incomparable excluded', () => {
  const rs = [
    rec({ result: { consistency: 'consistent' } }),
    rec({ result: { consistency: 'divergent' }, taskId: 'G2' }),
    rec({ result: { consistency: 'incomparable' }, taskId: 'G3' }),
  ]
  const s = agreementStats(rs as JevReviewRecord[])
  assert.equal(s.total, 2)
  assert.equal(s.agree, 1)
  assert.equal(s.rate, 0.5)
  assert.equal(s.incomparable, 1)
  assert.deepEqual(s.divergentIds, ['G2'])
})

test('drift flags only samples with 2+ readings and differing verdicts', () => {
  const rs = [
    rec({ taskId: 'G1', kind: 'good', result: { choice: { choice: 'none', probabilities: null, confidence: 0.9 } } }),
    rec({ taskId: 'G1', kind: 'good', result: { choice: { choice: 'none', probabilities: null, confidence: 0.9 } } }),
    rec({ taskId: 'G1', kind: 'good', result: { choice: { choice: 'partial', probabilities: null, confidence: 0.8 } } }),
    rec({ taskId: 'G2', kind: 'good', result: { choice: { choice: 'exact', probabilities: null, confidence: 0.9 } } }),
  ]
  const s = driftStats(rs as JevReviewRecord[])
  assert.equal(s.samples, 1)
  assert.equal(s.drifted, 1)
  assert.equal(s.rate, 1)
  assert.deepEqual(s.driftedKeys, ['G1:good'])
})

test('calibration buckets split by combined confidence; 80-90 decides pass/fail', () => {
  const mk = (conf: number, ok: boolean) =>
    rec({
      result: {
        consistency: ok ? 'consistent' : 'divergent',
        choice: { choice: 'none', probabilities: null, confidence: conf },
        agreement: { score: 1, probabilities: null, confidence: conf },
      },
    })
  const buckets = calibrationBuckets([
    ...Array.from({ length: 8 }, () => mk(0.85, true)),
    ...Array.from({ length: 2 }, () => mk(0.85, false)),
    ...Array.from({ length: 5 }, () => mk(0.95, true)),
  ] as JevReviewRecord[])
  const mid = buckets.find((b) => b.lo === 0.8)!
  assert.equal(mid.n, 10)
  assert.equal(mid.rate, 0.8)
  assert.equal(calibrationStatus(buckets), 'pass')
  assert.equal(buckets.find((b) => b.lo === 0.9)!.rate, 1)
  assert.equal(buckets.find((b) => b.lo === 0)!.n, 0)
})

test('calibration fails only when the 80-90 bucket falls below 70% (one-sided)', () => {
  const mk = (ok: boolean) =>
    rec({
      result: {
        consistency: ok ? 'consistent' : 'divergent',
        choice: { choice: 'none', probabilities: null, confidence: 0.85 },
        agreement: { score: 1, probabilities: null, confidence: 0.85 },
      },
    })
  const buckets = calibrationBuckets([...Array.from({ length: 3 }, () => mk(true)), ...Array.from({ length: 7 }, () => mk(false))] as JevReviewRecord[])
  assert.equal(calibrationStatus(buckets), 'fail')
  assert.equal(calibrationConservative(buckets), false)
  assert.equal(calibrationStatus([]), 'unknown')
})

test('calibration passes above 90% with a conservative note, not a block', () => {
  const mk = () =>
    rec({
      result: {
        consistency: 'consistent',
        choice: { choice: 'none', probabilities: null, confidence: 0.85 },
        agreement: { score: 1, probabilities: null, confidence: 0.85 },
      },
    })
  const buckets = calibrationBuckets(Array.from({ length: 10 }, () => mk()) as JevReviewRecord[])
  assert.equal(buckets.find((b) => b.lo === 0.8)!.rate, 1)
  assert.equal(calibrationStatus(buckets), 'pass')
  assert.equal(calibrationConservative(buckets), true)
})

test('90–100 bucket is a hard gate too: below 80% fails, missing 80–90 stays pending', () => {
  const mk = (conf: number, ok: boolean) =>
    rec({
      result: {
        consistency: ok ? 'consistent' : 'divergent',
        choice: { choice: 'none', probabilities: null, confidence: conf },
        agreement: { score: 1, probabilities: null, confidence: conf },
      },
    })
  // 90–100 桶 0% → fail（即使 80–90 桶无数据）
  const badTop = calibrationBuckets([...Array.from({ length: 30 }, () => mk(0.95, false))] as JevReviewRecord[])
  assert.equal(calibrationStatus(badTop), 'fail')
  // 恰好 80% → 过线（严格小于才拦）；80–90 无数据 → 待测
  const edge = calibrationBuckets([...Array.from({ length: 4 }, () => mk(0.95, true)), ...Array.from({ length: 1 }, () => mk(0.95, false))] as JevReviewRecord[])
  assert.equal(calibrationStatus(edge), 'unknown')
  // 双桶都有数据且都过线 → pass
  const both = calibrationBuckets([
    ...Array.from({ length: 9 }, () => mk(0.85, true)),
    ...Array.from({ length: 1 }, () => mk(0.85, false)),
    ...Array.from({ length: 4 }, () => mk(0.95, true)),
    ...Array.from({ length: 1 }, () => mk(0.95, false)),
  ] as JevReviewRecord[])
  assert.equal(calibrationStatus(both), 'pass')
  // 80–90 过线但 90–100 只有 40% → fail
  const topLow = calibrationBuckets([
    ...Array.from({ length: 10 }, () => mk(0.85, true)),
    ...Array.from({ length: 2 }, () => mk(0.95, true)),
    ...Array.from({ length: 3 }, () => mk(0.95, false)),
  ] as JevReviewRecord[])
  assert.equal(calibrationStatus(topLow), 'fail')
})

test('agreement split by source', () => {
  const rs = [
    rec({ result: { source: 'decided', consistency: 'consistent' } }),
    rec({ result: { source: 'decided', consistency: 'divergent' } }),
    rec({ result: { source: 'error', consistency: 'incomparable' } }),
  ] as JevReviewRecord[]
  const bySource = agreementBySource(rs)
  const decided = bySource.find((s) => s.source === 'decided')!
  assert.equal(decided.total, 2)
  assert.equal(decided.agree, 1)
  assert.equal(decided.rate, 0.5)
  // 调用失败没有读数可比对：单独成一栏，judged=0、rate=null（不进一致率）。
  const errored = bySource.find((s) => s.source === 'error')!
  assert.equal(errored.total, 1)
  assert.equal(errored.judged, 0)
  assert.equal(errored.rate, null)
})

test('source distribution, cost percentiles and trap rollup', () => {
  const rs = [
    rec({ result: { source: 'decided', latencyMs: 100 } }),
    rec({ result: { source: 'error', latencyMs: 900, error: 'boom' } }),
    rec({ taskId: 'S1', domain: 'security', result: { source: 'decided', latencyMs: 500 } }),
  ] as JevReviewRecord[]
  assert.deepEqual(sourceDist(rs), { decided: 2, error: 1 })
  const cost = costStats(rs)
  assert.equal(cost.count, 3)
  assert.equal(cost.p50, 500)
  // 回落通道已取消：成本只累判定模型自身用量。
  const trap = trapStats(rs, new Set(['S1']))
  assert.equal(trap.total, 1)
  assert.equal(trap.bypass, 0)
})

test('confidence stats report the achieved distribution', () => {
  const mk = (choice: number, score: number) =>
    rec({
      result: {
        choice: { choice: 'none', probabilities: null, confidence: choice },
        agreement: { score: 1, probabilities: null, confidence: score },
      },
    })
  const rs = [mk(0.8, 0.77), mk(0.95, 0.93), mk(0.95, 0.93)] as JevReviewRecord[]
  const s = confidenceStats(rs)
  assert.equal(s.total, 3)
  assert.equal(s.hit, 0)
  assert.equal(s.min!.toFixed(2), '0.77')
  assert.equal(s.max!.toFixed(2), '0.93')
  assert.deepEqual(confidenceStats([]), { avg: null, min: null, max: null, hit: 0, total: 0 })
})
