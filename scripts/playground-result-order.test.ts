// The Run tab result list must read General → Legal → Security, then by question
// number, with one row per question and its configs side by side. These pin that
// order so a future refactor cannot quietly turn G10 back into a row above G2.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allSettled, buildRows, pickActiveRun, questionNumber } from '../src/screens/Playground/resultOrder'
import type { RunSummary } from '../shared/playground'

function run(over: Partial<RunSummary> & Pick<RunSummary, 'taskId' | 'domain'>): RunSummary {
  // One distinct configuration identity per preset; an evolved configuration
  // (no preset) gets its own. Cells are keyed by this, never by a display label.
  const presetId = 'presetId' in over ? (over.presetId ?? null) : 'C0'
  const fingerprint = over.fingerprint ?? (presetId ? `fp-${presetId}` : 'fp-evolved')
  return {
    runId: `${over.taskId}-${presetId ?? 'evolved'}-${over.createdAt ?? ''}`,
    taskTitle: `title of ${over.taskId}`,
    split: 'repair',
    presetId,
    fingerprint,
    configLabel: presetId ?? 'Evolved #1',
    configTitle: null,
    status: 'scored',
    source: 'live',
    success: null,
    score: null,
    tokens: null,
    latencyMs: null,
    costUsd: null,
    failureTags: [],
    model: 'm',
    temperature: null,
    seed: null,
    eventCount: 0,
    hasTrajectory: false,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    finishedAt: null,
    ...over,
  }
}

test('question numbers sort numerically, so G2 precedes G10', () => {
  assert.equal(questionNumber('G2'), 2)
  assert.equal(questionNumber('G10'), 10)
  assert.ok(questionNumber('G2') < questionNumber('G10'))
})

test('rows are grouped General → Legal → Security regardless of arrival order', () => {
  const rows = buildRows([
    run({ taskId: 'S1', domain: 'security' }),
    run({ taskId: 'L1', domain: 'legal' }),
    run({ taskId: 'G1', domain: 'general' }),
  ])
  assert.deepEqual(rows.map((r) => r.taskId), ['G1', 'L1', 'S1'])
})

test('within a domain rows follow the question number, not the string', () => {
  const rows = buildRows([
    run({ taskId: 'G10', domain: 'general' }),
    run({ taskId: 'G2', domain: 'general' }),
    run({ taskId: 'G1', domain: 'general' }),
  ])
  assert.deepEqual(rows.map((r) => r.taskId), ['G1', 'G2', 'G10'])
})

test('one row per question, with each harness config as its own cell', () => {
  const rows = buildRows([
    run({ taskId: 'G1', domain: 'general', presetId: 'C0' }),
    run({ taskId: 'G1', domain: 'general', presetId: 'C1' }),
    run({ taskId: 'G2', domain: 'general', presetId: 'C0' }),
  ])
  assert.equal(rows.length, 2)
  assert.deepEqual([...rows[0].cells.keys()], ['fp-C0', 'fp-C1'])
  assert.deepEqual([...rows[1].cells.keys()], ['fp-C0'])
})

test('re-running the same config keeps the newest run and still counts the old one', () => {
  const rows = buildRows([
    run({ taskId: 'G1', domain: 'general', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z', success: false }),
    run({ taskId: 'G1', domain: 'general', presetId: 'C0', createdAt: '2026-02-01T00:00:00.000Z', success: true }),
  ])
  const cell = rows[0].cells.get('fp-C0')!
  assert.equal(cell.count, 2)
  assert.equal(cell.run.success, true, 'the newer run is the one shown')
})

test('a configuration with no preset name still gets its own column', () => {
  const rows = buildRows([run({ taskId: 'L3', domain: 'legal', presetId: null })])
  assert.deepEqual([...rows[0].cells.keys()], ['fp-evolved'])
})

test('one configuration is ONE column even when one of its runs carries no preset name', () => {
  // The reported bug: the re-run/verification runs of the C0 configuration are
  // created without a preset name, so the list showed "C0" and a separate
  // "custom" column for what is a single configuration. Identity is the
  // configuration itself, not the label a particular run happens to carry.
  const rows = buildRows([
    run({ taskId: 'G1', domain: 'general', presetId: 'C0', fingerprint: 'fp-c0', configLabel: 'C0' }),
    run({ taskId: 'G1', domain: 'general', presetId: null, fingerprint: 'fp-c0', configLabel: 'C0' }),
  ])
  assert.deepEqual([...rows[0].cells.keys()], ['fp-c0'])
  assert.equal(rows[0].cells.get('fp-c0')!.count, 2)
})

// ── pickActiveRun: which run the detail panel shows ───────────────────────────
// The bug these pin: the old `cur ?? …` kept a selection *forever*, so after
// starting a run the list refreshed but the panel stayed on the previous run —
// the user reads that as "the run I just launched returned that old result".

test('no runs → nothing to show', () => {
  assert.equal(pickActiveRun([], null), null)
})

test('nothing selected yet → the newest run (list arrives newest-first)', () => {
  const runs = [
    run({ taskId: 'G2', domain: 'general', runId: 'newest' }),
    run({ taskId: 'G1', domain: 'general', runId: 'older' }),
  ]
  assert.equal(pickActiveRun(runs, null), 'newest')
})

test('an explicit selection is kept while it is still in the list', () => {
  const runs = [
    run({ taskId: 'G2', domain: 'general', runId: 'newest' }),
    run({ taskId: 'G1', domain: 'general', runId: 'picked' }),
  ]
  assert.equal(pickActiveRun(runs, 'picked'), 'picked', 'must not steal the user’s pick')
})

test('a selection the list no longer contains falls back to the newest', () => {
  // Happens when the config filter narrows the list under an existing selection.
  const runs = [run({ taskId: 'G2', domain: 'general', runId: 'newest' })]
  assert.equal(pickActiveRun(runs, 'filtered-away'), 'newest')
})

test('does not pin the panel to a run that died mid-flight', () => {
  // Regression: preferring any queued/running run meant one stuck run (server
  // killed mid-run) captured the panel forever, hiding every newer result.
  const runs = [
    run({ taskId: 'G2', domain: 'general', runId: 'fresh-scored', status: 'scored' }),
    run({ taskId: 'G1', domain: 'general', runId: 'stuck-running', status: 'running' }),
  ]
  assert.equal(pickActiveRun(runs, null), 'fresh-scored')
})

// ── allSettled: when a run detail fetch is final ─────────────────────────────
//
// The scorecard shows answer/verdict/ROUGE read off the run detail. A run that is
// still in flight has none of them, so treating "fetched" as "finished" left a whole
// column of dashes next to a run that had already completed.

test('a run still in flight is not settled', () => {
  assert.equal(allSettled([run({ taskId: 'G1', domain: 'general', status: 'running' })]), false)
  assert.equal(allSettled([run({ taskId: 'G1', domain: 'general', status: 'queued' })]), false)
})

test('scored and error are both final — a failed run is not pending', () => {
  assert.equal(allSettled([run({ taskId: 'G1', domain: 'general', status: 'scored' })]), true)
  assert.equal(allSettled([run({ taskId: 'G1', domain: 'general', status: 'error' })]), true)
})

test('one run in flight keeps the whole scorecard polling', () => {
  const runs = [
    run({ taskId: 'G1', domain: 'general', presetId: 'C0', status: 'scored' }),
    run({ taskId: 'G1', domain: 'general', presetId: 'C1', status: 'running' }),
  ]
  assert.equal(allSettled(runs), false)
})
