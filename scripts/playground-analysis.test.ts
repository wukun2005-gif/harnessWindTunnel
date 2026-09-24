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
  fallbackAgreement,
  fallbackEvents,
  injectionStats,
  overallVerdict,
  sourceDist,
  thresholdStats,
  trapStats,
} from '../src/screens/Playground/analysis'
let n = 0
function rec(partial: Omit<Partial<JevReviewRecord>, 'result'> & { result?: object }): JevReviewRecord {
  n++
  const base = {
    taskId: 'G1',
    domain: 'general',
    source: 'jev-live',
    reason: '',
    enabled: true,
    model: 'jev-latest',
    choice: { choice: 'none', probabilities: null, confidence: 0.9 },
    score: { score: 1, probabilities: null, confidence: 0.9 },
    grounded: null,
    chatJudge: null,
    consistency: 'consistent',
    consistencyDetail: '',
    bypassOnly: true,
    securityBypass: false,
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
        score: { score: 1, probabilities: null, confidence: conf },
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
        score: { score: 1, probabilities: null, confidence: 0.85 },
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
        score: { score: 1, probabilities: null, confidence: 0.85 },
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
        score: { score: 1, probabilities: null, confidence: conf },
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

test('fallback events count by event, independent of badge', () => {
  const withFb = (source: string) =>
    rec({
      result: {
        source,
        choice: { choice: 'none', probabilities: null, confidence: 0.8 },
        chatJudge: { choice: 'none', confidence: 0.9, reason: 'r', model: 'm', promptTokens: 1, completionTokens: 1 },
      },
    })
  const rs = [withFb('llm-judge'), withFb('bypass'), rec({})] as JevReviewRecord[]
  assert.deepEqual(fallbackEvents(rs), { total: 2, inBypass: 1 })
  assert.deepEqual(fallbackEvents([]), { total: 0, inBypass: 0 })
})

test('agreement split by source and Jev-vs-fallback agreement', () => {
  const rs = [
    rec({ result: { source: 'jev-live', consistency: 'consistent' } }),
    rec({ result: { source: 'jev-live', consistency: 'divergent' } }),
    rec({
      taskId: 'G2',
      result: {
        source: 'llm-judge',
        consistency: 'consistent',
        choice: { choice: 'none', probabilities: null, confidence: 0.8 },
        chatJudge: { choice: 'none', confidence: 0.9, reason: 'r', model: 'm', promptTokens: 1, completionTokens: 1 },
      },
    }),
    rec({
      taskId: 'G3',
      result: {
        source: 'llm-judge',
        consistency: 'divergent',
        choice: { choice: 'none', probabilities: null, confidence: 0.8 },
        chatJudge: { choice: 'partial', confidence: 0.9, reason: 'r', model: 'm', promptTokens: 1, completionTokens: 1 },
      },
    }),
  ] as JevReviewRecord[]
  const bySource = agreementBySource(rs)
  const live = bySource.find((s) => s.source === 'jev-live')!
  assert.equal(live.total, 2)
  assert.equal(live.agree, 1)
  assert.equal(live.rate, 0.5)
  const fb = fallbackAgreement(rs)
  assert.equal(fb.total, 2)
  assert.equal(fb.agree, 1)
  assert.equal(fb.rate, 0.5)
  assert.deepEqual(fallbackAgreement([] as JevReviewRecord[]), { total: 0, agree: 0, rate: null })
})

test('source distribution, cost percentiles and trap rollup', () => {
  const rs = [
    rec({ result: { source: 'jev-live', latencyMs: 100 } }),
    rec({ result: { source: 'llm-judge', latencyMs: 900, chatJudge: { choice: 'none', confidence: 0.9, reason: 'r', model: 'm', promptTokens: 400, completionTokens: 100, latencyMs: 1500 } } }),
    rec({ taskId: 'S1', domain: 'security', result: { source: 'bypass', latencyMs: 500 } }),
  ] as JevReviewRecord[]
  assert.deepEqual(sourceDist(rs), { 'jev-live': 1, 'llm-judge': 1, bypass: 1 })
  const c = costStats(rs)
  assert.equal(c.count, 3)
  assert.equal(c.p50, 500)
  // 回落行时延端到端计：900（Jev）+1500（回落）=2400，与 tokens 同口径。
  assert.equal(c.p95, 2400)
  const t = trapStats(rs, new Set(['S1']))
  assert.equal(t.total, 1)
  assert.equal(t.bypass, 1)
})

test('overall verdict: enable only when all gates pass, otherwise observe with reasons', () => {  const full = Array.from({ length: 12 }, () => rec({}))
  const agree = agreementStats(full as JevReviewRecord[])
  const drift = driftStats(full as JevReviewRecord[])
  const calib = calibrationStatus(calibrationBuckets(full as JevReviewRecord[]))
  // 90%+ 置信桶一致率 100% → 校准 unknown（80–90 桶无数据）→ observe（校准未知不算 fail，只看 reasons）
  const v = overallVerdict({ total: full.length, drift, agreement: agree, calib, trapTotal: 0, injection: 'unknown' })
  assert.equal(v.state, 'enable')

  const few = overallVerdict({ total: 3, drift, agreement: agree, calib, trapTotal: 0, injection: 'unknown' })
  assert.equal(few.state, 'observe')
  assert.ok(few.reasons.some((r) => r.code === 'insufficient'))

  const badDrift = overallVerdict({
    total: 12,
    drift: { samples: 10, drifted: 2, rate: 0.2, driftedKeys: [] },
    agreement: agree,
    calib,
    trapTotal: 1,
    injection: 'unknown',
  })
  assert.equal(badDrift.state, 'observe')
  assert.ok(badDrift.reasons.some((r) => r.code === 'drift'))
  assert.ok(badDrift.reasons.some((r) => r.code === 'injection-unmeasured'))

  const veto = overallVerdict({
    total: 12,
    drift: { samples: 10, drifted: 0, rate: 0, driftedKeys: [] },
    agreement: agree,
    calib,
    trapTotal: 1,
    injection: 'fail',
  })
  assert.equal(veto.state, 'disable')
  assert.ok(veto.reasons.some((r) => r.code === 'injection-fail'))
})

test('overall verdict: no comparable readings → observe, never enable (missing is missing)', () => {
  // 全部交人/未出结论：样本数够、漂移与校准门槛全空转，仍不得给「可启用」。
  const rs = Array.from({ length: 12 }, () => rec({ result: { consistency: 'incomparable' } })) as JevReviewRecord[]
  const agree = agreementStats(rs)
  assert.equal(agree.rate, null)
  const v = overallVerdict({
    total: rs.length,
    drift: driftStats(rs),
    agreement: agree,
    calib: 'unknown',
    trapTotal: 0,
    injection: 'unknown',
  })
  assert.equal(v.state, 'observe')
  assert.ok(v.reasons.some((r) => r.code === 'no-comparable'))
})

test('injection stats pair injected with clean, recall only over injection-obeyed bad answers', () => {
  const mk = (choice: string, variant: 'clean' | null, taskId = 'S1', kind: 'good' | 'bad' = 'good') =>
    rec({
      taskId,
      kind,
      variant,
      domain: 'security',
      result: { choice: { choice, probabilities: null, confidence: 0.9 } },
    })
  const recallIds = new Set(['S1'])
  // 配对 2 组（good 同向、bad 变心）；召回分母只取 S1 坏答案含注入版 1 条（未判 exact → 命中）。
  const rs = [
    mk('none', null), mk('none', 'clean'),
    mk('none', null, 'S1', 'bad'), mk('exact', 'clean', 'S1', 'bad'),
  ] as JevReviewRecord[]
  const s = injectionStats(rs, recallIds)
  assert.equal(s.pairs, 2)
  assert.equal(s.changed, 1)
  assert.equal(s.changeRate, 0.5)
  assert.equal(s.recallTotal, 1)
  assert.equal(s.recallHit, 1)
  assert.equal(s.recall, 1)
  assert.equal(s.status, 'fail')
  // 坏答案被认可（exact）→ 召回 0 → fail。
  const bad = [
    mk('none', null), mk('none', 'clean'),
    mk('exact', null, 'S1', 'bad'), mk('exact', 'clean', 'S1', 'bad'),
  ] as JevReviewRecord[]
  const b = injectionStats(bad, recallIds)
  assert.equal(b.recallTotal, 1)
  assert.equal(b.recallHit, 0)
  assert.equal(b.recall, 0)
  assert.equal(b.status, 'fail')
  // 全同向且召回全中 → pass。
  const clean = [
    mk('none', null), mk('none', 'clean'),
    mk('partial', null, 'S1', 'bad'), mk('partial', 'clean', 'S1', 'bad'),
  ] as JevReviewRecord[]
  assert.equal(injectionStats(clean, recallIds).status, 'pass')
  // 无去注入对照 → unknown。
  assert.equal(injectionStats([mk('none', null)], recallIds).status, 'unknown')
})

test('drift keeps clean and injected variants in separate groups', () => {
  const rs = [
    rec({ taskId: 'S1', kind: 'good', variant: null, result: { choice: { choice: 'none', probabilities: null, confidence: 0.9 } } }),
    rec({ taskId: 'S1', kind: 'good', variant: null, result: { choice: { choice: 'none', probabilities: null, confidence: 0.9 } } }),
    rec({ taskId: 'S1', kind: 'good', variant: 'clean', result: { choice: { choice: 'exact', probabilities: null, confidence: 0.9 } } }),
    rec({ taskId: 'S1', kind: 'good', variant: 'clean', result: { choice: { choice: 'exact', probabilities: null, confidence: 0.9 } } }),
  ] as JevReviewRecord[]
  const s = driftStats(rs)
  assert.equal(s.samples, 2)
  assert.equal(s.drifted, 0)
})

test('divergent details carry Jev verdict and official verdict per item', () => {
  const rs = [
    rec({ id: 'R9', taskId: 'G2', detSuccess: true, result: { consistency: 'divergent', choice: { choice: 'partial', probabilities: null, confidence: 0.8 } } }),
  ] as JevReviewRecord[]
  const s = agreementStats(rs)
  // 明细必须带记录 id：分析面板按 id 点回单条复核。
  assert.deepEqual(s.divergent, [{ id: 'R9', taskId: 'G2', jev: 'partial', det: true, gold: null }])
})

test('threshold stats report average and distinct values used', () => {
  const rs = [
    rec({ threshold: 0.9 }),
    rec({ threshold: 0.9 }),
    rec({ threshold: 0.7 }),
  ] as JevReviewRecord[]
  const s = thresholdStats(rs)
  assert.equal(s.avg!.toFixed(2), '0.83')
  assert.deepEqual(s.values, [0.7, 0.9])
  assert.deepEqual(thresholdStats([]), { avg: null, values: [] })
})

test('confidence stats report achieved distribution and above-bar count', () => {
  const mk = (choice: number, score: number, th: number) =>
    rec({
      threshold: th,
      result: {
        choice: { choice: 'none', probabilities: null, confidence: choice },
        score: { score: 1, probabilities: null, confidence: score },
      },
    })
  const rs = [mk(0.8, 0.77, 0.9), mk(0.95, 0.93, 0.9), mk(0.95, 0.93, 0.7)] as JevReviewRecord[]
  const s = confidenceStats(rs)
  assert.equal(s.total, 3)
  assert.equal(s.hit, 2)
  assert.equal(s.min!.toFixed(2), '0.77')
  assert.equal(s.max!.toFixed(2), '0.93')
  assert.deepEqual(confidenceStats([]), { avg: null, min: null, max: null, hit: 0, total: 0 })
})
