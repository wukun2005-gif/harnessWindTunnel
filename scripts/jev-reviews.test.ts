// A/B 记录（M1 §17.9）离线单测：落盘 append-only、查询过滤、坏行容错。
// 记录落盘失败永不抛错（不能让记账影响判分）。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { JevReviewRecord } from '../shared/jev'
import { listReviews, clearReviews, reviewsFile, saveReview } from '../server/playground/jevReviews'

process.env['HWT_JEV_REVIEWS_FILE'] = join(mkdtempSync(join(tmpdir(), 'hwt-reviews-')), 'jev-reviews.jsonl')

function rec(partial: Partial<JevReviewRecord> & { id: string; taskId: string }): JevReviewRecord {
  return {
    time: '2026-09-22T00:00:00.000Z',
    domain: 'general',
    split: 'repair',
    scorerType: 'field-match',
    answer: 'a',
    detSuccess: false,
    detScore: 0,
    threshold: 0.9,
    cascadeEnabled: true,
    result: {
      taskId: partial.taskId,
      domain: 'general',
      source: 'bypass',
      reason: '',
      enabled: true,
      model: null,
      choice: null,
      score: null,
      grounded: null,
      chatJudge: null,
      consistency: 'incomparable',
      consistencyDetail: '',
      bypassOnly: true,
      securityBypass: false,
      stateChars: 0,
      estimatedPromptTokens: 0,
      stateSharesInjectedPayload: false,
      stateTruncated: false,
      latencyMs: null,
      error: null,
    },
    ...partial,
  } as JevReviewRecord
}

test('save appends and list filters by task, domain and time range', () => {
  saveReview(rec({ id: 'r1', taskId: 'G1', time: '2026-09-20T00:00:00.000Z' }))
  saveReview(rec({ id: 'r2', taskId: 'G2', time: '2026-09-21T00:00:00.000Z' }))
  saveReview(rec({ id: 'r3', taskId: 'S1', domain: 'security', time: '2026-09-22T00:00:00.000Z' }))

  assert.deepEqual(listReviews().map((r) => r.id), ['r1', 'r2', 'r3'])
  assert.deepEqual(listReviews({ task: 'G1' }).map((r) => r.id), ['r1'])
  assert.deepEqual(listReviews({ domain: 'security' }).map((r) => r.id), ['r3'])
  assert.deepEqual(listReviews({ from: '2026-09-21T00:00:00.000Z' }).map((r) => r.id), ['r2', 'r3'])
  assert.deepEqual(listReviews({ to: '2026-09-20T12:00:00.000Z' }).map((r) => r.id), ['r1'])
  assert.deepEqual(listReviews({ limit: 2 }).map((r) => r.id), ['r2', 'r3'])
})

test('corrupt lines are skipped and a missing file reads as empty', () => {
  writeFileSync(reviewsFile(), 'not json\n{"id": 1}\n', { flag: 'a' })
  const ids = listReviews().map((r) => r.id)
  assert.ok(ids.includes('r1') && ids.includes('r3'))

  process.env['HWT_JEV_REVIEWS_FILE'] = join(tmpdir(), `hwt-missing-${Date.now()}`, 'x.jsonl')
  assert.deepEqual(listReviews(), [])
})

test('save never throws, even on an unwritable path', () => {
  process.env['HWT_JEV_REVIEWS_FILE'] = tmpdir()
  assert.doesNotThrow(() => saveReview(rec({ id: 'rx', taskId: 'G1' })))
})

test('records carry a batch id; clear removes one batch or everything', () => {
  process.env['HWT_JEV_REVIEWS_FILE'] = join(mkdtempSync(join(tmpdir(), 'hwt-batch-')), 'jev-reviews.jsonl')
  saveReview(rec({ id: 'b1', taskId: 'G1', batchId: 'batch-a' }))
  saveReview(rec({ id: 'b2', taskId: 'G2', batchId: 'batch-a' }))
  saveReview(rec({ id: 'b3', taskId: 'G1', batchId: 'batch-b' }))

  assert.deepEqual(listReviews({ batch: 'batch-a' }).map((r) => r.id), ['b1', 'b2'])
  assert.equal(clearReviews({ batchId: 'batch-a' }), 2)
  assert.deepEqual(listReviews().map((r) => r.id), ['b3'])
  assert.equal(clearReviews({ batchId: 'nope' }), 0)
  assert.equal(clearReviews({}), 0)
  assert.equal(clearReviews({ all: true }), 1)
  assert.deepEqual(listReviews(), [])
})
