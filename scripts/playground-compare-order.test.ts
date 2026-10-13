// The three dropdowns on the Live tab's "Trajectory divergence" section (question,
// Config A, Config B) must read in a fixed order. They used to render in run-arrival
// order — the run list arrives newest-first — so the question list jumped around
// unrelated questions and each configuration showed up scattered through the A/B
// lists. These pin the order.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildCompareTasks, dedupeRuns, naturalCompare, pickDefaultPair, sortRuns } from '../src/screens/Playground/compareOrder'
import type { RunSummary } from '../shared/playground'

function run(over: Partial<RunSummary> & Pick<RunSummary, 'taskId' | 'domain'>): RunSummary {
  const presetId = 'presetId' in over ? (over.presetId ?? null) : 'C0'
  return {
    runId: `${over.taskId}-${presetId ?? 'evolved'}-${over.createdAt ?? ''}`,
    taskTitle: `title of ${over.taskId}`,
    split: 'repair',
    presetId,
    fingerprint: over.fingerprint ?? `fp-${presetId}`,
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

test('natural order compares digit runs as numbers', () => {
  assert.ok(naturalCompare('C2', 'C10') < 0, 'C2 must precede C10')
  assert.ok(naturalCompare('Evolved #10', 'Evolved #2') > 0)
  assert.equal(naturalCompare('C0', 'C0'), 0)
})

test('questions are grouped General → Legal → Security regardless of arrival order', () => {
  const tasks = buildCompareTasks([
    run({ taskId: 'S1', domain: 'security', presetId: 'C1', createdAt: '2026-03-01T00:00:00.000Z' }),
    run({ taskId: 'S1', domain: 'security', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z' }),
    run({ taskId: 'L1', domain: 'legal', presetId: 'C1', createdAt: '2026-02-01T00:00:00.000Z' }),
    run({ taskId: 'L1', domain: 'legal', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z' }),
    run({ taskId: 'G1', domain: 'general', presetId: 'C1', createdAt: '2026-02-01T00:00:00.000Z' }),
    run({ taskId: 'G1', domain: 'general', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(tasks.map((t) => t.id), ['G1', 'L1', 'S1'])
})

test('within a domain questions follow the number, so S2 precedes S10', () => {
  const tasks = buildCompareTasks([
    run({ taskId: 'S10', domain: 'security', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z' }),
    run({ taskId: 'S10', domain: 'security', presetId: 'C1', createdAt: '2026-02-01T00:00:00.000Z' }),
    run({ taskId: 'S2', domain: 'security', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z' }),
    run({ taskId: 'S2', domain: 'security', presetId: 'C1', createdAt: '2026-02-01T00:00:00.000Z' }),
    run({ taskId: 'S1', domain: 'security', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z' }),
    run({ taskId: 'S1', domain: 'security', presetId: 'C1', createdAt: '2026-02-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(tasks.map((t) => t.id), ['S1', 'S2', 'S10'])
})

test('a question with a single configuration is not offered — A and B cannot differ', () => {
  const tasks = buildCompareTasks([
    run({ taskId: 'G1', domain: 'general' }),
    run({ taskId: 'G1', domain: 'general', presetId: 'C1' }),
    run({ taskId: 'G2', domain: 'general' }),
  ])
  assert.deepEqual(tasks.map((t) => t.id), ['G1'])
})

test('the title shown is the newest run’s, not whichever arrived last', () => {
  const tasks = buildCompareTasks([
    run({ taskId: 'S6', domain: 'security', presetId: 'C1', taskTitle: 'new title', createdAt: '2026-05-01T00:00:00.000Z' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', taskTitle: 'old title', createdAt: '2026-01-01T00:00:00.000Z' }),
  ])
  assert.equal(tasks[0]!.title, 'new title')
})

test('configurations are grouped and label-sorted, so C2 precedes C10', () => {
  const sorted = sortRuns([
    run({ taskId: 'S6', domain: 'security', fingerprint: 'fp-c10', configLabel: 'C10' }),
    run({ taskId: 'S6', domain: 'security', fingerprint: 'fp-c2', configLabel: 'C2' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C0' }),
  ])
  assert.deepEqual(sorted.map((r) => r.configLabel), ['C0', 'C2', 'C10'])
})

test('an evolved configuration follows the presets, in its own numeric order', () => {
  const sorted = sortRuns([
    run({ taskId: 'S6', domain: 'security', presetId: null, fingerprint: 'fp-evo-10', configLabel: 'Evolved #10' }),
    run({ taskId: 'S6', domain: 'security', presetId: null, fingerprint: 'fp-evo-2', configLabel: 'Evolved #2' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C1', configLabel: 'C1' }),
    run({ taskId: 'S6', domain: 'security', presetId: null, fingerprint: 'fp-evo-1', configLabel: 'Evolved #1' }),
  ])
  assert.deepEqual(sorted.map((r) => r.configLabel), ['C1', 'Evolved #1', 'Evolved #2', 'Evolved #10'])
})

// ── dedup: one entry per configuration ───────────────────────────────────────
// Re-running one configuration repeated its name in the picker, so A and B could
// be handed two runs of the SAME configuration and compare it with itself.

test('re-running one configuration shows it once, carrying the newest run', () => {
  const sorted = sortRuns([
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C1', runId: 'other', createdAt: '2026-02-01T00:00:00.000Z' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'new', createdAt: '2026-03-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(sorted.map((r) => r.runId), ['new', 'other'])
})

test('the newest run of a repeated configuration wins even if it arrives first', () => {
  const sorted = sortRuns([
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'new', createdAt: '2026-03-01T00:00:00.000Z' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(sorted.map((r) => r.runId), ['new'])
})

test('two runs carrying different names but one configuration collapse into one', () => {
  // Identity is the configuration (fingerprint), not the label on the run — the
  // same rule the run matrix columns use. The entry carries the newest run, so
  // it shows the name that run resolved.
  const sorted = sortRuns([
    run({ taskId: 'S6', domain: 'security', presetId: null, fingerprint: 'fp-c0', configLabel: 'custom', runId: 'new', createdAt: '2026-02-01T00:00:00.000Z' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', fingerprint: 'fp-c0', configLabel: 'C0', runId: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(sorted.map((r) => r.runId), ['new'])
})

test('dedup keeps arrival order, so it composes with the sorting rules', () => {
  assert.deepEqual(
    dedupeRuns([
      run({ taskId: 'S6', domain: 'security', presetId: 'C1', runId: 'c1-new', createdAt: '2026-03-01T00:00:00.000Z' }),
      run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'c0' }),
      run({ taskId: 'S6', domain: 'security', presetId: 'C1', runId: 'c1-old', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]).map((r) => r.runId),
    ['c1-new', 'c0'],
  )
})

test('a question run twice under ONE configuration is not offered for comparison', () => {
  // Nothing to compare: A and B would hold the same configuration.
  const tasks = buildCompareTasks([
    run({ taskId: 'G1', domain: 'general', presetId: 'C0', createdAt: '2026-02-01T00:00:00.000Z' }),
    run({ taskId: 'G1', domain: 'general', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z' }),
    run({ taskId: 'G2', domain: 'general', presetId: 'C0', createdAt: '2026-01-01T00:00:00.000Z' }),
    run({ taskId: 'G2', domain: 'general', presetId: 'C1', createdAt: '2026-01-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(tasks.map((t) => t.id), ['G2'])
})

// ── pickDefaultPair: what A and B compare before anyone touches them ─────────
// Sorting the pickers must be display-only. Picking the fallback off the sorted
// list changed which two runs the panel compares on every question.

test('the fallback pair is the two most recent runs of the question', () => {
  // Arrival order (newest first), three configurations C2 / C1 / C0.
  const runs = [
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'c0' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C1', runId: 'c1' }),
    run({ taskId: 'S6', domain: 'security', fingerprint: 'fp-c2', configLabel: 'C2', runId: 'c2' }),
  ]
  assert.deepEqual(pickDefaultPair(runs, 'S6'), ['c0', 'c1'])
})

test('sorting the picker list does not move the fallback pair', () => {
  const runs = [
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'c0' }),
    run({ taskId: 'S6', domain: 'security', fingerprint: 'fp-c2', configLabel: 'C2', runId: 'c2' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C1', runId: 'c1' }),
  ]
  // Display order puts C0 first, which would have made C0+C2 the pair.
  assert.deepEqual(sortRuns(runs).map((r) => r.runId), ['c0', 'c1', 'c2'])
  assert.deepEqual(pickDefaultPair(runs, 'S6'), ['c0', 'c2'])
})

test('the fallback pair holds two DIFFERENT configurations', () => {
  // The two most recent runs were re-runs of C0; after dedup C0 still holds the
  // newest, so the second slot must come from the next configuration rather than
  // from a second copy of C0 (which is no longer in the picker).
  const runs = [
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'c0-rerun' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'c0-first' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C1', runId: 'c1' }),
  ]
  assert.deepEqual(pickDefaultPair(runs, 'S6'), ['c0-rerun', 'c1'])
})

test('every run the fallback picks is actually in the picker list', () => {
  const runs = [
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'c0-rerun' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', runId: 'c0-first' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C1', runId: 'c1' }),
  ]
  const offered = new Set(buildCompareTasks(runs)[0]!.runs.map((r) => r.runId))
  for (const id of pickDefaultPair(runs, 'S6')) {
    assert.ok(offered.has(id), `${id} must be selectable — otherwise the dropdown renders blank`)
  }
})

test('another question’s runs are never drawn into the pair', () => {
  const runs = [
    run({ taskId: 'S1', domain: 'security', runId: 'other' }),
    run({ taskId: 'S6', domain: 'security', runId: 'c0' }),
  ]
  assert.deepEqual(pickDefaultPair(runs, 'S6'), ['c0', ''])
})

test('a question with no runs yields an empty pair rather than throwing', () => {
  assert.deepEqual(pickDefaultPair([], 'S6'), ['', ''])
})

test('each question’s runs come back pre-sorted for the A/B pickers', () => {
  const tasks = buildCompareTasks([
    run({ taskId: 'S6', domain: 'security', presetId: 'C1', createdAt: '2026-03-01T00:00:00.000Z' }),
    run({ taskId: 'S6', domain: 'security', presetId: null, fingerprint: 'fp-evo-1', configLabel: 'Evolved #1', createdAt: '2026-04-01T00:00:00.000Z' }),
    run({ taskId: 'S6', domain: 'security', presetId: 'C0', createdAt: '2026-05-01T00:00:00.000Z' }),
  ])
  assert.deepEqual(tasks[0]!.runs.map((r) => r.configLabel), ['C0', 'C1', 'Evolved #1'])
})