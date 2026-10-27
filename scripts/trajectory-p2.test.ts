// P2 guards: same-task consistency, live-only stability, model tags, and the
// contract-gating lesson from the replay audit. The contract corpus now covers
// all 45 eval tasks, so the guards below run over every task, not a pilot set.
//
// The replay guard at the bottom is the one that would have caught the first
// contract set: it fails when a required checkpoint is never observed in most
// recorded runs, which is the signature of a rulebook written against an
// imagined trajectory rather than the recorded one.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { HarnessEvent } from '../shared/events'
import type { TrajectoryVerdictDetail } from '../shared/trajectory'
import { buildConsistency, buildStability, type PilotRunReading } from '../shared/trajectoryStats'
import { buildTagDigest, getTrajectoryTags, parseTagResponse, saveTagRecordForTest } from '../server/playground/trajectoryTags'
import { getLiveContractForTask, loadLiveContracts } from '../server/trajectoryStore'
import { getRunDetail, listRuns, liveDbFile, useLiveDbPath } from '../server/playground/liveDb'
import { evaluateEvents } from '../shared/trajectoryEval'

const CONTRACT = { contractId: 'tc-test', version: '1.1.0' }

function reading(over: Partial<PilotRunReading> = {}): PilotRunReading {
  return {
    runId: 'run_a',
    taskId: 'G4',
    fingerprint: 'fp1',
    configLabel: 'C0',
    createdAt: '2026-10-01T00:00:00.000Z',
    source: 'live',
    status: 'scored',
    bucket: 'trusted-success',
    cell: 'trusted-success',
    hardViolation: false,
    softViolations: 0,
    csr: 1,
    firstDivergence: null,
    pathSignature: 'cp-a>cp-b',
    matchedPath: 'p1',
    terminalSuccess: true,
    judgeSuccess: true,
    judgeScore: 1,
    missingCheckpoints: [],
    ...over,
  }
}

// --- consistency -------------------------------------------------------------
test('consistency: the earliest run is the reference and agreement is counted per run', () => {
  const report = buildConsistency(
    [
      reading({ runId: 'run_late', createdAt: '2026-10-03T00:00:00.000Z' }),
      reading({ runId: 'run_ref', createdAt: '2026-10-01T00:00:00.000Z' }),
      reading({ runId: 'run_fluke', createdAt: '2026-10-02T00:00:00.000Z', bucket: 'fluke-success', cell: 'fluke-success', hardViolation: true, csr: 0.5, pathSignature: 'cp-b>cp-a' }),
    ],
    CONTRACT,
  )
  assert.equal(report.reference?.runId, 'run_ref')
  assert.equal(report.rows.length, 2)
  assert.equal(report.verdict, 'mixed')
  assert.equal(report.agree, 1)
  assert.equal(report.compared, 2)
  const fluke = report.rows.find((r) => r.reading.runId === 'run_fluke')!
  assert.equal(fluke.agreesCell, false)
  assert.equal(fluke.agreesHard, false)
  assert.ok(fluke.diffs.includes('cell') && fluke.diffs.includes('hardViolation'))
})

test('consistency: a checkpoint missing in most runs becomes a suspect, never a silent pass', () => {
  const report = buildConsistency(
    [
      reading({ runId: 'r1', createdAt: '2026-10-01T00:00:00.000Z', missingCheckpoints: ['cp-audit'] }),
      reading({ runId: 'r2', createdAt: '2026-10-02T00:00:00.000Z', missingCheckpoints: ['cp-audit'] }),
      reading({ runId: 'r3', createdAt: '2026-10-03T00:00:00.000Z' }),
    ],
    CONTRACT,
  )
  assert.deepEqual(report.suspects.map((s) => s.id), ['cp-audit'])
  assert.equal(report.suspects[0].missing, 2)
  assert.equal(report.suspects[0].runs, 3)
})

test('consistency: one recorded run is "insufficient", not "consistent"', () => {
  const report = buildConsistency([reading()], CONTRACT)
  assert.equal(report.verdict, 'insufficient')
  assert.equal(report.rows.length, 0)
})

// --- stability ---------------------------------------------------------------
test('stability: pass^k is the without-replacement draw and imported runs are excluded', () => {
  const readings = [
    reading({ runId: 'r1', createdAt: '2026-10-01T00:00:00.000Z' }),
    reading({ runId: 'r2', createdAt: '2026-10-02T00:00:00.000Z' }),
    reading({ runId: 'r3', createdAt: '2026-10-03T00:00:00.000Z', bucket: 'clear-failure', cell: 'clear-failure' }),
    reading({ runId: 'r4', createdAt: '2026-10-04T00:00:00.000Z', source: 'imported' }),
  ]
  const report = buildStability(readings, CONTRACT)
  assert.equal(report.runs, 3, 'imported records never enter a live stability figure')
  const g = report.groups[0]
  assert.equal(g.runs, 3)
  assert.equal(g.trusted, 2)
  assert.equal(g.allPass, false)
  assert.equal(g.k, 3)
  // C(2,3)=0 → no draw of three passes.
  assert.equal(g.passK, 0)
})

test('stability: pass^k is 1 when every run of a configuration passed', () => {
  const readings = [
    reading({ runId: 'r1', createdAt: '2026-10-01T00:00:00.000Z' }),
    reading({ runId: 'r2', createdAt: '2026-10-02T00:00:00.000Z' }),
    reading({ runId: 'r3', createdAt: '2026-10-03T00:00:00.000Z' }),
    reading({ runId: 'r4', createdAt: '2026-10-04T00:00:00.000Z' }),
  ]
  const report = buildStability(readings, CONTRACT)
  assert.equal(report.groups[0].passK, 1)
  assert.equal(report.groups[0].dominantShare, 1)
  assert.equal(report.pooledPassK, 1)
})

test('stability: a configuration run once is not a stability reading', () => {
  const report = buildStability([reading()], CONTRACT)
  assert.equal(report.groups.length, 0)
  assert.equal(report.pooledPassK, null)
})

// --- model tags --------------------------------------------------------------
test('tags: unknown tags are dropped, confidence is clamped, records are non-gold', () => {
  const out = parseTagResponse(
    JSON.stringify({
      tags: [
        { tag: 'weak-grounding', confidence: 1.7, why: 'unsupported figure at step 3', step: 3 },
        { tag: 'not-a-tag', confidence: 0.9, why: 'nope', step: 1 },
        { tag: 'fabricated-citation', confidence: 0.4, why: 'missing article', step: 2 },
      ],
      summary: 'two findings',
    }),
    { runId: 'run_x', contractId: 'tc', contractVersion: '1.1.0', providerId: 'p', model: 'm', generatedAt: '2026-10-26T00:00:00.000Z' },
  )
  assert.equal(out.ok, true)
  if (!out.ok) return
  assert.deepEqual(out.record.tags.map((t) => t.tag), ['weak-grounding', 'fabricated-citation'])
  assert.equal(out.record.tags[0].confidence, 0.5, 'out-of-range confidence falls back, never amplifies')
  assert.equal(out.record.nonGold, true)
  assert.equal(out.record.promptVersion, 'traj-tags-1')
})

test('tags: a non-JSON answer is an error, never an empty "clean" reading', () => {
  const out = parseTagResponse('sure! looks fine', {
    runId: 'r', contractId: 'c', contractVersion: '1.0.0', providerId: 'p', model: 'm', generatedAt: '2026-10-26T00:00:00.000Z',
  })
  assert.equal(out.ok, false)
})

test('tags: the digest never feeds narrator labels or the scorer tags back to the model', () => {
  const events = [
    { type: 'run.started', author: 'harness', id: 'e1', ts: 1, runId: 'r', scenarioId: 's', model: 'm', task: 'G11' },
    { type: 'model.request', author: 'harness', step: 1, blocks: [], estTokens: 10, id: 'e2', ts: 2, runId: 'r', scenarioId: 's' },
    { type: 'model.response', author: 'harness', step: 1, thought: '审理要点清单', stopReason: 'stop', id: 'e3', ts: 3, runId: 'r', scenarioId: 's' },
    { type: 'failure.tag', author: 'narrator', step: 1, mast: 'fabricated-citation', confidence: 0.99, note: 'narrator says so', id: 'e4', ts: 4, runId: 'r', scenarioId: 's' },
    { type: 'run.finished', author: 'harness', success: true, tokens: 10, latencyP50: 1, failureModes: {}, id: 'e5', ts: 5, runId: 'r', scenarioId: 's' },
  ] as unknown as HarnessEvent[]
  const verdict = {
    terminalSuccess: true, csr: 1, hardViolation: false, firstDivergence: null,
    checkpoints: [{ id: 'cp-answer', kind: 'required', completed: true, unknown: false, applies: true, evidenceEventId: 'e3', completedAtStep: 1, windowClosedAtStep: null }],
  } as unknown as TrajectoryVerdictDetail
  const digest = buildTagDigest({ taskId: 'G11', taskTitle: 'checklist', domain: 'general', answer: 'answer', events, verdict })
  assert.equal(digest.includes('narrator says so'), false)
  assert.equal(digest.includes('fabricated-citation'), false)
  assert.ok(digest.includes('审理要点清单'))
})

test('tags: a saved record round-trips with its non-gold marker intact', () => {
  const previous = liveDbFile()
  useLiveDbPath(':memory:')
  const record = {
    runId: 'run_roundtrip', contractId: 'tc', contractVersion: '1.1.0',
    providerId: 'p', model: 'm', nonGold: true as const, promptVersion: 'traj-tags-1',
    tags: [{ tag: 'weak-grounding' as const, confidence: 0.7, why: 'why', step: 1 }],
    summary: 's', generatedAt: '2026-10-26T00:00:00.000Z',
  }
  try {
    saveTagRecordForTest(record)
    assert.deepEqual(getTrajectoryTags('run_roundtrip'), record)
    assert.equal(getTrajectoryTags('run_missing'), null)
  } finally {
    // The DB path is process-global; leaving it on :memory: would make every
    // later replay assertion pass over an empty corpus.
    useLiveDbPath(previous)
  }
})

// --- contract gating (the replay lesson) -------------------------------------
test('live contracts gate any rule that depends on a capability the harness may not mount', () => {
  for (const c of loadLiveContracts()) {
    for (const cp of c.checkpoints) {
      const needsVerifier = cp.observable.eventTypes.includes('verifier.verdict') || (cp.observable.anyOf ?? []).some((o) => o.eventTypes.includes('verifier.verdict'))
      const needsTool = (cp.observable.match?.['tool'] ?? '').startsWith('patent_law')
      if ((needsVerifier || needsTool) && cp.kind === 'required') {
        assert.ok(cp.appliesWhen, `${c.contractId}/${cp.id}: a required checkpoint on a mountable capability needs appliesWhen`)
      }
    }
    for (const fa of c.forbiddenActions) {
      const needsVerifier = (fa.requires?.observable.eventTypes ?? []).includes('verifier.verdict')
      if (needsVerifier) {
        assert.ok(fa.appliesWhen, `${c.contractId}/${fa.id}: a submission rule that needs an auditor must be gated`)
      }
    }
  }
})

// --- replay guard over the recorded corpus -----------------------------------
test('replay: no contract checkpoint is known-missing across most recorded runs', (t) => {
  const db = resolve('server-data', 'playground.db')
  if (!existsSync(db)) {
    t.skip('no local playground DB — replay guard runs where the corpus exists')
    return
  }
  for (const c of loadLiveContracts()) {
    const taskId = c.target.id
    const runs = listRuns({ taskId, limit: 500 })
    if (runs.length < 3) continue
    const missing = new Map<string, number>()
    let evaluated = 0
    for (const r of runs) {
      const detail = getRunDetail(r.runId)
      if (!detail || detail.events.length === 0) continue
      const v = evaluateEvents(c, detail.events, 'live')
      evaluated += 1
      for (const cp of v.checkpoints) {
        if (cp.kind !== 'required' || cp.completed || cp.unknown) continue
        missing.set(cp.id, (missing.get(cp.id) ?? 0) + 1)
      }
    }
    assert.ok(evaluated >= Math.min(3, runs.length), `${taskId}: replay read ${evaluated}/${runs.length} runs`)
    for (const [id, n] of missing) {
      assert.ok(
        n / evaluated < 0.8,
        `${c.contractId}/${id}: known-missing in ${n}/${evaluated} recorded runs — the contract is probably describing a step the task never takes`,
      )
    }
  }
})

test('replay: every eval task resolves its own contract and nothing else', () => {
  const ids = loadLiveContracts().map((c) => c.target.id).sort()
  assert.equal(ids.length, 45)
  for (const id of ids) {
    const c = getLiveContractForTask(id)
    assert.ok(c, id)
    assert.equal(c?.target.kind, 'task')
    assert.equal(c?.target.id, id)
  }
  assert.equal(getLiveContractForTask('G99'), undefined)
})

// --- rubber-stamp guard ------------------------------------------------------
// The plan's bottom line: every contract must be shown to stop at least one
// trajectory that SHOULD fail. A contract that cannot fail is a rubber stamp,
// so every contract gets a hand-built negative sample here. These are synthetic
// on purpose — the point is the rule, not the corpus.
let negSeq = 0
function neg(type: string, extra: Record<string, unknown>): HarnessEvent {
  negSeq += 1
  return { id: `neg${negSeq}`, ts: negSeq * 10, runId: 'run_neg', scenarioId: 'sc', author: 'harness', type, ...extra } as unknown as HarnessEvent
}
const NEG_START = neg('run.started', { model: 'test', task: 'neg' })
const tinyRequest = (): HarnessEvent => neg('model.request', { step: 1, blocks: [], estTokens: 10 })
const statuteRequest = (): HarnessEvent =>
  neg('model.request', {
    step: 1,
    blocks: [{ layer: 'toolSchema', sourceComponent: 'patent_law_search, patent_law_get_article, patent_law_verify_citation' }],
    estTokens: 10,
  })
const NEG_ANSWER = neg('model.response', { step: 1, thought: '答复', stopReason: 'end_turn' })
const NEG_TOOL_TURN = neg('model.response', { step: 1, thought: '先调用工具', stopReason: 'tool_calls' })
const NEG_FINISH = neg('run.finished', { success: true, tokens: 10, latencyP50: 1, failureModes: {} })
const NEG_REJECT = (): HarnessEvent =>
  neg('verifier.verdict', { step: 1, verifier: 'audit', verdict: 'reject', reason: 'fabricated' })

// Task families whose failure signature differs:
//  - grounded reading tasks need source material before the answer;
//  - legal tasks must not submit after a rejected citation audit;
//  - security tasks are stopped at a gate, or must actually answer.
const GROUNDED_TASKS = ['G1', 'G2', 'G3', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G12', 'G13', 'G14', 'G15']
const LEGAL_TASKS = [
  'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'L10',
  'L11', 'L13', 'L14', 'L15', 'L16', 'L17', 'L18', 'L19', 'L21',
]
const CONTEXTUAL_SECURITY = ['S1', 'S4', 'S7']
const ANSWER_ONLY_SECURITY = ['S8', 'S9']

const NEGATIVES: Record<string, HarnessEvent[]> = {}
for (const id of GROUNDED_TASKS) NEGATIVES[id] = [NEG_START, tinyRequest(), NEG_ANSWER, NEG_FINISH]
for (const id of LEGAL_TASKS) NEGATIVES[id] = [NEG_START, statuteRequest(), NEG_ANSWER, NEG_REJECT(), NEG_FINISH]
// No source material reached the model at all.
for (const id of CONTEXTUAL_SECURITY) NEGATIVES[id] = [NEG_START, NEG_ANSWER, NEG_FINISH]
// The run ended without ever emitting a final answer.
for (const id of ANSWER_ONLY_SECURITY) NEGATIVES[id] = [NEG_START, tinyRequest(), NEG_TOOL_TURN, NEG_FINISH]

// Pilot contracts with their own failure signature.
NEGATIVES['G4'] = [NEG_START, tinyRequest(), NEG_ANSWER, NEG_FINISH]
NEGATIVES['G11'] = [NEG_START, tinyRequest(), NEG_ANSWER, NEG_REJECT(), NEG_FINISH]
NEGATIVES['L12'] = [NEG_START, tinyRequest(), NEG_ANSWER, NEG_REJECT(), NEG_FINISH]
// Statute tools mounted, Article 88 asserted with no lookup.
NEGATIVES['L20'] = [NEG_START, statuteRequest(), NEG_ANSWER, NEG_FINISH]
// Non-public access granted.
NEGATIVES['S2'] = [NEG_START, tinyRequest(), NEG_ANSWER, neg('permission.granted', { step: 1, scope: 'nonpublic/case-file' }), NEG_FINISH]
// Egress gate allowed the sensitive text out.
NEGATIVES['S6'] = [NEG_START, tinyRequest(), NEG_ANSWER, neg('hook.decision', { step: 1, hook: 'egress-dlp', verdict: 'allow', reason: 'matched nothing' }), NEG_FINISH]
NEGATIVES['S3'] = [NEG_START, tinyRequest(), NEG_ANSWER, neg('hook.decision', { step: 1, hook: 'egress-dlp', verdict: 'allow', reason: 'matched nothing' }), NEG_FINISH]
NEGATIVES['S5'] = [NEG_START, tinyRequest(), NEG_ANSWER, neg('permission.granted', { step: 1, scope: 'nonpublic/examiner-private' }), NEG_FINISH]

test('every contract stops a trajectory that should fail (no rubber stamps)', () => {
  const contracts = loadLiveContracts()
  assert.equal(contracts.length, 45)
  for (const contract of contracts) {
    const taskId = contract.target.id
    const events = NEGATIVES[taskId]
    assert.ok(events, `${taskId}: no negative sample — a contract that cannot fail is a rubber stamp`)
    const v = evaluateEvents(contract, events, 'live')
    const flagged = v.hardViolation || v.processIncomplete || v.cell === null || v.cell === 'fluke-success'
    assert.ok(
      flagged,
      `${taskId}: a trajectory that should fail still reads as ${v.cell} (csr=${v.csr}, hard=${v.hardViolation})`,
    )
  }
})
