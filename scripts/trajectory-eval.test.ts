import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HarnessEvent } from '../shared/events'
import type { Observable, TrajectoryContract, TrajectorySource } from '../shared/trajectory'
import { eventMatches, evaluateEvents, normalizeTrace } from '../shared/trajectoryEval'

// --- synthetic event builders -------------------------------------------------
let seq = 0
const ev = (type: string, extra: Record<string, unknown>): HarnessEvent => {
  seq += 1
  return {
    id: `e${seq}`, ts: seq * 10, runId: 'run-test', scenarioId: 'scenario-test',
    author: type === 'failure.tag' ? 'narrator' : type === 'imported' ? 'imported' : 'harness',
    type, ...extra,
  } as unknown as HarnessEvent
}
const start = (): HarnessEvent => ev('run.started', { model: 'test-model', task: 'test task' })
const finish = (success: boolean): HarnessEvent => ev('run.finished', { success, tokens: 100, latencyP50: 10, failureModes: {} })
const req = (step: number): HarnessEvent => ev('model.request', { step, blocks: [], estTokens: 10 })
const res = (step: number, thought: string): HarnessEvent => ev('model.response', { step, thought, stopReason: 'end_turn' })
const call = (step: number, tool: string, argsSummary = ''): HarnessEvent => ev('tool.call', { step, tool, argsSummary })
const result = (step: number, tool: string, summary = ''): HarnessEvent => ev('tool.result', { step, tool, tokens: 10, summary })

function contract(over: Partial<TrajectoryContract> = {}): TrajectoryContract {
  return {
    contractId: 'tc-test',
    target: { kind: 'scenario', id: 'scenario-test' },
    version: '1.0.0',
    author: 'test',
    reviewer: 'test',
    checkpoints: [{
      id: 'cp-a', kind: 'required',
      observable: { eventTypes: ['tool.call'], match: { tool: 'a' } },
      description: 'Run tool a',
    }],
    allowedPaths: [{ id: 'p1', nodes: ['cp-a'], edges: [] }],
    allowedActions: [],
    forbiddenActions: [],
    completion: [{ id: 'done', terminal: { success: true }, description: 'done' }],
    recoveryWindow: 2,
    provenanceRule: 'fixture',
    singlePathExemption: 'test',
    ...over,
  }
}

const evaluate = (c: TrajectoryContract, events: HarnessEvent[], source: TrajectorySource = 'fixture') =>
  evaluateEvents(c, events, source)

// --- five step verdicts and priority -----------------------------------------
test('five step verdicts: required, neutral, redundant', () => {
  const events = [
    start(), req(1), res(1, 'use a'), call(1, 'a'), result(1, 'a'),
    req(2), res(2, 'same thought'), call(2, 'b'), result(2, 'b'),
    req(3), res(3, 'same thought'), call(3, 'b'), result(3, 'b'),
    finish(true),
  ]
  const v = evaluate(contract(), events)
  assert.deepEqual(v.steps.map((s) => s.verdict), ['required', 'neutral', 'redundant'])
  assert.equal(v.steps[0].reason, 'checkpoint-advanced')
  assert.equal(v.steps[2].reason, 'redundant-repeat')
})

test('priority: violating beats a checkpoint completed in the same step', () => {
  const events = [
    start(), req(1), call(1, 'a'), call(1, 'bad'), finish(true),
  ]
  const c = contract({
    forbiddenActions: [{
      id: 'xf-bad', label: 'bad', severity: 'hard',
      observable: { eventTypes: ['tool.call'], match: { tool: 'bad' } },
      description: 'bad call',
    }],
  })
  const v = evaluate(c, events)
  assert.equal(v.steps[0].verdict, 'violating')
  assert.equal(v.steps[0].severity, 'hard')
  assert.equal(v.steps[0].ruleId, 'xf-bad')
  assert.equal(v.hardViolation, true)
  assert.equal(v.cell, 'fluke-success')
})

test('priority: violating beats recovering in the same step', () => {
  const events = [
    start(), req(1), result(1, 'x', 'soft problem'), req(2), call(2, 'a'), call(2, 'bad'), finish(true),
  ]
  const c = contract({
    forbiddenActions: [
      {
        id: 'xf-soft', label: 'soft', severity: 'soft',
        observable: { eventTypes: ['tool.result'], match: { 'summary~=': 'soft problem' } },
        description: 'soft problem',
      },
      {
        id: 'xf-hard', label: 'hard', severity: 'hard',
        observable: { eventTypes: ['tool.call'], match: { tool: 'bad' } },
        description: 'bad call',
      },
    ],
  })
  const v = evaluate(c, events)
  assert.equal(v.steps[1].verdict, 'violating')
  assert.equal(v.steps[1].severity, 'hard')
})

// --- blocked-and-correct ------------------------------------------------------
for (const gate of ['permission.denied', 'router.decision', 'hook.decision'] as const) {
  test(`blocked and correct: ${gate} is positive evidence, not a violation`, () => {
    const events = [start(), req(1), call(1, 'mail.send', 'to: ext-relay')]
    if (gate === 'permission.denied') events.push(ev('permission.denied', { step: 1, scope: 'mail.send(external)', gate: 'egress', reason: 'not allowlisted' }))
    if (gate === 'router.decision') events.push(ev('router.decision', { step: 1, tool: 'mail.send', route: 'REFUSE', matchedRule: 'egress', policyVersion: 'v1' }))
    if (gate === 'hook.decision') events.push(ev('hook.decision', { step: 1, hook: 'egress', verdict: 'deny', reason: 'not allowlisted' }))
    events.push(finish(true))
    const c = contract({
      checkpoints: [],
      forbiddenActions: [{
        id: 'xf-ext', label: 'external send', severity: 'hard',
        observable: { eventTypes: ['tool.call'], match: { tool: 'mail.send' } },
        description: 'external send',
      }],
    })
    // Schema requires a required checkpoint; this unit test targets the evaluator only.
    const v = evaluate(c, events)
    assert.equal(v.hardViolation, false)
    assert.equal(v.steps[0].verdict, 'neutral')
    assert.equal(v.steps[0].blockedCorrect, true)
    assert.equal(v.metrics.tcv, 1)
  })
}

// --- first divergence ---------------------------------------------------------
test('first divergence: an executed hard-forbidden action kills every path', () => {
  const events = [start(), req(1), call(1, 'a'), req(2), call(2, 'bad'), finish(false)]
  const c = contract({
    forbiddenActions: [{
      id: 'xf-bad', label: 'bad', severity: 'hard',
      observable: { eventTypes: ['tool.call'], match: { tool: 'bad' } },
      description: 'bad call',
    }],
  })
  const v = evaluate(c, events)
  assert.equal(v.firstDivergence, 2)
  assert.match(v.divergenceReason ?? '', /^hard-kill:/)
})

test('first divergence: a violated ordering edge is located at the later checkpoint', () => {
  const events = [
    start(), req(1), call(1, 'b'), result(1, 'b'),
    req(2), call(2, 'a'), result(2, 'a'), finish(true),
  ]
  const c = contract({
    checkpoints: [
      { id: 'cp-a', kind: 'required', observable: { eventTypes: ['tool.call'], match: { tool: 'a' } }, description: 'A' },
      { id: 'cp-b', kind: 'required', observable: { eventTypes: ['tool.call'], match: { tool: 'b' } }, description: 'B' },
    ],
    allowedPaths: [{ id: 'p1', nodes: ['cp-a', 'cp-b'], edges: [['cp-a', 'cp-b']] }],
  })
  const v = evaluate(c, events)
  assert.equal(v.firstDivergence, 1)
  assert.match(v.divergenceReason ?? '', /^edge-violated:cp-a>cp-b$/)
})

test('first divergence: a closed checkpoint window is located at the closing event', () => {
  const events = [
    start(), req(1), res(1, 'wrap up now'), req(2), call(2, 'a'), finish(true),
  ]
  const c = contract({
    checkpoints: [{
      id: 'cp-a', kind: 'required',
      observable: { eventTypes: ['tool.call'], match: { tool: 'a' } },
      window: { closesWith: { eventTypes: ['model.response'], match: { 'thought~=': 'wrap up' } }, label: 'wrap-up' },
      description: 'A before wrap-up',
    }],
  })
  const v = evaluate(c, events)
  assert.equal(v.firstDivergence, 1)
  assert.match(v.divergenceReason ?? '', /^window-closed:cp-a$/)
  assert.equal(v.checkpoints[0].completed, false)
})

// --- recovery -----------------------------------------------------------------
test('recovery: a soft incident followed by a checkpoint inside the window is recorded as recovering', () => {
  const events = [
    start(), req(1), result(1, 'x', 'soft problem'), req(2), call(2, 'a'), result(2, 'a'), finish(true),
  ]
  const c = contract({
    recoveryWindow: 2,
    forbiddenActions: [{
      id: 'xf-soft', label: 'soft', severity: 'soft',
      observable: { eventTypes: ['tool.result'], match: { 'summary~=': 'soft problem' } },
      description: 'soft problem',
    }],
  })
  const v = evaluate(c, events)
  assert.equal(v.steps[0].verdict, 'violating')
  assert.equal(v.steps[1].verdict, 'recovering')
  assert.equal(v.softViolations, 1)
  assert.equal(v.metrics.recovery, 1)
  assert.equal(v.firstDivergence, null)
  assert.equal(v.cell, 'trusted-success')
})

test('recovery: a checkpoint outside the window is not a recovery', () => {
  const events = [
    start(), req(1), result(1, 'x', 'soft problem'),
    req(2), req(3), req(4), call(4, 'a'), finish(true),
  ]
  const c = contract({
    recoveryWindow: 2,
    forbiddenActions: [{
      id: 'xf-soft', label: 'soft', severity: 'soft',
      observable: { eventTypes: ['tool.result'], match: { 'summary~=': 'soft problem' } },
      description: 'soft problem',
    }],
  })
  const v = evaluate(c, events)
  assert.equal(v.steps[3].verdict, 'required')
  assert.equal(v.metrics.recovery, 0)
})

// --- unknown ------------------------------------------------------------------
test('unknown: import without the evidence domain never becomes 0 and blocks the cell', () => {
  const events = [start(), req(1), res(1, 'no tool events in this import'), finish(true)]
  const v = evaluate(contract(), events, 'imported')
  assert.equal(v.checkpoints[0].unknown, true)
  assert.equal(v.checkpoints[0].completed, false)
  assert.equal(v.csr, null) // unknown never enters the denominator
  assert.equal(v.cell, null)
  assert.equal(v.steps[0].unknown, true)
})

test('unknown: a truncated fixture stream marks neutral steps unknown and leaves the cell open', () => {
  const events = [start(), req(1), res(1, 'cut off here')] // no run.finished
  const v = evaluate(contract(), events, 'fixture')
  assert.equal(v.terminalSuccess, null)
  assert.equal(v.cell, null)
  assert.equal(v.steps[0].unknown, true)
})

test('unknown does not enter the CSR denominator when another required checkpoint passes', () => {
  const events = [start(), req(1), call(1, 'a'), finish(true)]
  const c = contract({
    checkpoints: [
      { id: 'cp-a', kind: 'required', observable: { eventTypes: ['tool.call'], match: { tool: 'a' } }, description: 'A' },
      { id: 'cp-missing', kind: 'required', observable: { eventTypes: ['legal.assertion'], match: { label: 'supported' } }, description: 'missing domain' },
    ],
  })
  const v = evaluate(c, events, 'imported')
  assert.equal(v.checkpoints[0].completed, true)
  assert.equal(v.checkpoints[1].unknown, true)
  assert.equal(v.csr, 1) // 1 passed / (2 required − 1 unknown)
})

// --- four cells ---------------------------------------------------------------
test('success without a required checkpoint is process-incomplete, never trusted success', () => {
  const v = evaluate(contract(), [start(), req(1), res(1, 'answer directly'), finish(true)])
  assert.equal(v.terminalSuccess, true)
  assert.equal(v.hardViolation, false)
  assert.equal(v.firstDivergence, null)
  assert.equal(v.csr, 0)
  assert.equal(v.processIncomplete, true)
  assert.equal(v.cell, null)
})

test('four cells: trusted success, fluke success, one step short, clear failure', () => {
  const trusted = evaluate(contract(), [start(), req(1), call(1, 'a'), finish(true)])
  assert.equal(trusted.cell, 'trusted-success')

  const fluke = evaluate(contract({
    forbiddenActions: [{
      id: 'xf-bad', label: 'bad', severity: 'hard',
      observable: { eventTypes: ['tool.call'], match: { tool: 'bad' } },
      description: 'bad call',
    }],
  }), [start(), req(1), call(1, 'a'), call(1, 'bad'), finish(true)])
  assert.equal(fluke.cell, 'fluke-success')

  const four = contract({
    checkpoints: ['a', 'b', 'c', 'd'].map((id) => ({
      id: `cp-${id}`, kind: 'required' as const,
      observable: { eventTypes: ['tool.call' as const], match: { tool: id } },
      description: id,
    })),
    allowedPaths: [{ id: 'p1', nodes: ['cp-a', 'cp-b', 'cp-c', 'cp-d'], edges: [] }],
  })
  const short = evaluate(four, [start(), req(1), call(1, 'a'), call(1, 'b'), req(2), call(2, 'c'), finish(false)])
  assert.equal(short.csr, 0.75)
  assert.equal(short.cell, 'one-step-short')
  assert.equal(short.metrics.pe, null) // PE only after CSR is complete

  const clear = evaluate(four, [start(), req(1), call(1, 'a'), call(1, 'b'), finish(false)])
  assert.equal(clear.csr, 0.5)
  assert.equal(clear.cell, 'clear-failure')
})

// --- determinism + narrator labels -------------------------------------------
test('determinism: the same events and contract produce a byte-identical verdict', () => {
  const events = [
    start(), req(1), res(1, 'use a'), call(1, 'a'), result(1, 'a'), req(2), finish(true),
  ]
  const c = contract()
  assert.deepEqual(evaluate(c, events), evaluate(c, events))
})

test('failure.tag is unmatchable and never drives a verdict', () => {
  const label = ev('failure.tag', { step: 1, mast: 'premature-victory', confidence: 1, note: 'contradicts the facts' })
  const events = [start(), req(1), res(1, 'use a'), call(1, 'a'), label, finish(true)]
  const v = evaluate(contract(), events)
  assert.equal(v.steps[0].verdict, 'required')
  assert.equal(v.hardViolation, false)
  assert.equal(v.firstDivergence, null)
  assert.equal(eventMatches({ eventTypes: ['failure.tag'], match: {} } as unknown as Observable, label), false)
})

test('no composite trajectory score is ever produced', () => {
  const v = evaluate(contract(), [start(), req(1), call(1, 'a'), finish(true)]) as unknown as Record<string, unknown>
  for (const forbidden of ['score', 'trajectoryScore', 'overall', 'composite']) {
    assert.equal(forbidden in v, false)
  }
})

// --- adapter ------------------------------------------------------------------
test('adapter: step-less tail events land in the bracketing step', () => {
  const events = [start(), req(1), call(1, 'a'), ev('harness.mutation', { commitId: 'c1', parentIds: [], configDiff: {}, predictedGain: [0, 0], falsification: { rescued: 0, regressed: 0 }, approvedBy: 'human' }), finish(true)]
  const t = normalizeTrace(events, 'fixture')
  assert.deepEqual(t.steps.map((s) => s.step), [1])
  assert.equal(t.steps[0].events.length, 3)
})

// --- capability gates (P2 replay audit, 2026-10-26) ---------------------------
// A harness that mounts no auditor must not be read as an agent that skipped
// the audit. These four tests pin the difference between "missing evidence"
// and "missing step", which is what made the first live contracts misfire.
const gatedContract = (): TrajectoryContract =>
  contract({
    checkpoints: [
      {
        id: 'cp-audit', kind: 'required',
        observable: { eventTypes: ['verifier.verdict'], match: { verdict: 'pass' } },
        appliesWhen: { eventTypes: ['verifier.verdict'] },
        description: 'audit passes',
      },
      {
        id: 'cp-answer', kind: 'required',
        observable: { eventTypes: ['model.response'], match: { 'stopReason!=': 'tool_calls' } },
        description: 'final answer',
      },
    ],
    allowedPaths: [{ id: 'p1', nodes: ['cp-audit', 'cp-answer'], edges: [] }],
    forbiddenActions: [{
      id: 'xf-unaudited', label: 'submitted unaudited', severity: 'hard',
      observable: { eventTypes: ['run.finished'] },
      appliesWhen: { eventTypes: ['verifier.verdict'] },
      requires: { observable: { eventTypes: ['verifier.verdict'], match: { verdict: 'pass' } } },
      description: 'submit needs a passing audit',
    }],
  })

test('gate: a checkpoint whose capability is not mounted reads unknown, not missing', () => {
  const v = evaluate(gatedContract(), [start(), req(1), res(1, 'answer'), finish(true)])
  const audit = v.checkpoints.find((c) => c.id === 'cp-audit')!
  assert.equal(audit.applies, false)
  assert.equal(audit.unknown, true)
  assert.equal(audit.completed, false)
  assert.equal(v.hardViolation, false, 'a submission cannot be unaudited when no auditor exists')
  assert.equal(v.csr, 1, 'the gated checkpoint leaves the CSR denominator')
  assert.equal(v.cell, null, 'no four-cell conclusion without the evidence domain')
  assert.equal(v.processIncomplete, false, 'missing evidence is not a missing step')
})

test('gate: with the capability mounted, a rejected audit is a hard violation', () => {
  const events = [
    start(), req(1), res(1, 'answer'),
    ev('verifier.verdict', { step: 1, verifier: 'audit', verdict: 'reject', reason: 'fabricated' }),
    finish(true),
  ]
  const v = evaluate(gatedContract(), events)
  const audit = v.checkpoints.find((c) => c.id === 'cp-audit')!
  assert.equal(audit.applies, true)
  assert.equal(audit.unknown, false)
  assert.equal(audit.completed, false)
  assert.equal(v.hardViolation, true)
  assert.equal(v.cell, 'fluke-success')
  assert.equal(v.csr, 0.5)
})

test('gate: a passing audit clears the forbidden rule', () => {
  const events = [
    start(), req(1), res(1, 'answer'),
    ev('verifier.verdict', { step: 1, verifier: 'audit', verdict: 'pass', reason: 'ok' }),
    finish(true),
  ]
  const v = evaluate(gatedContract(), events)
  assert.equal(v.hardViolation, false)
  assert.equal(v.cell, 'trusted-success')
  assert.equal(v.csr, 1)
})

test('matching: numeric comparisons and serialized nested payloads', () => {
  const withBlocks = ev('model.request', { step: 1, estTokens: 5000, blocks: [{ layer: 'toolSchema', sourceComponent: 'fs_read, patent_law_get_article' }] })
  assert.equal(eventMatches({ eventTypes: ['model.request'], match: { 'estTokens>=': '2000' } }, withBlocks), true)
  assert.equal(eventMatches({ eventTypes: ['model.request'], match: { 'estTokens<': '2000' } }, withBlocks), false)
  assert.equal(eventMatches({ eventTypes: ['model.request'], match: { 'blocks~=': 'patent_law' } }, withBlocks), true)
  assert.equal(eventMatches({ eventTypes: ['model.request'], match: { 'blocks~=': 'web_search' } }, withBlocks), false)
})

test('walk signature and matched path are derived, deterministic, and score-free', () => {
  const v = evaluate(gatedContract(), [
    start(), req(1), res(1, 'answer'),
    ev('verifier.verdict', { step: 1, verifier: 'audit', verdict: 'pass', reason: 'ok' }),
    finish(true),
  ])
  assert.equal(v.pathSignature, 'cp-answer>cp-audit')
  assert.equal(v.matchedPath, 'p1')
  const again = evaluate(gatedContract(), [
    start(), req(1), res(1, 'answer'),
    ev('verifier.verdict', { step: 1, verifier: 'audit', verdict: 'pass', reason: 'ok' }),
    finish(true),
  ])
  assert.equal(again.pathSignature, v.pathSignature)
})
