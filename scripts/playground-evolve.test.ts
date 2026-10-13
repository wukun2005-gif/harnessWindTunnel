import assert from 'node:assert/strict'
import { test } from 'node:test'
import { routeCluster, capabilityAlreadyOn, HARD_GATE_SEAMS } from '../server/playground/router'
import { validateMiddleware } from '../server/playground/cardFactory'
import { pairedGain, bootstrapLiftPp, paretoFrontier, gateStats } from '../server/playground/gainEstimator'
import { applyCardToConfig } from '../server/playground/falsifier'
import { clusterRuns } from '../server/playground/cluster'
import {
  chooseAutoCard,
  chooseRaceCards,
  chooseTopCards,
  reachedNoLiftStop,
  NO_LIFT_LIMIT,
  paretoAxisOf,
  paretoCostOf,
  staleGuard,
  BOOT_ID,
} from '../server/playground/evolve'
import { pickParetoWinner } from '../server/playground/gainEstimator'
import { gateRepeatsFor, GATE_REPEATS_MAX, GATE_REPEATS_SUGGESTED } from '../server/playground/falsifier'
import { useLiveDbPath } from '../server/playground/liveDb'
import { BASE_CONFIG, cfg } from '../shared/config'
import type { ChangeCard } from '../shared/playground'

test('router maps deterministic failure tags to middleware with hard gates', () => {
  const pv = routeCluster('premature-victory', [])
  assert.equal(pv.surface, 'middleware')
  assert.equal(pv.dsl.selfVerify, 'premature-victory-check')
  assert.equal(pv.hardGate, false)

  const fc = routeCluster('fabricated-citation', [])
  if (fc.surface === 'human') throw new Error('fabricated-citation must not be human')
  assert.equal(fc.surface, 'middleware')
  assert.equal(fc.dsl.sensors, 'verifier')
  assert.equal(fc.mount.patentLawMcp, true)
  assert.equal(fc.hardGate, true)

  const sv = routeCluster('scope-violation', [])
  if (sv.surface === 'human') throw new Error('scope-violation must not be human')
  assert.equal(sv.dsl.permissions, 'deny-first')
  assert.equal(sv.hardGate, true)
})

test('router sends prompt-fixable tags to the prompt surface', () => {
  const c = routeCluster('fail-to-clarify', [])
  assert.equal(c.surface, 'prompt')
  assert.equal(c.guideStyle, 'style-rules')
  assert.deepEqual(c.dsl, {})
})

test('dynamic upgrade never downgrades prompt → joint → middleware', () => {
  const tag = 'fail-to-clarify' as never
  assert.equal(routeCluster(tag, []).surface, 'prompt')
  assert.equal(routeCluster(tag, [{ surface: 'prompt' }]).surface, 'joint')
  assert.equal(routeCluster(tag, [{ surface: 'prompt' }, { surface: 'joint' }]).surface, 'middleware')
  // joint-starting tags upgrade straight to middleware.
  assert.equal(routeCluster('weak-grounding' as never, [{ surface: 'joint' }]).surface, 'middleware')
})

test('other is forced to human review', () => {
  const r = routeCluster('other' as never, [])
  assert.equal(r.surface, 'human')
})

test('middleware validation accepts legal enum values and rejects illegal', () => {
  const routed = new Set(['selfVerify'])
  const ok = validateMiddleware({ selfVerify: 'premature-victory-check' }, routed)
  assert.equal(ok.rejected.length, 0)
  assert.equal(ok.inTable, true)

  const bad = validateMiddleware({ selfVerify: 'totally-off' }, routed)
  assert.equal(bad.rejected.length, 1)
  assert.deepEqual(bad.valid, {})

  const offTable = validateMiddleware({ selfVerify: 'premature-victory-check', memory: 'layered' }, routed)
  assert.equal(offTable.inTable, false)
  assert.equal(offTable.rejected.length, 0)
})

test('hard-gate seam set covers permissions/globalPolicy/sandbox/authority/citation', () => {
  for (const s of ['permissions', 'globalPolicy', 'sandbox', 'authority-mcp', 'citation-audit']) {
    assert.ok(HARD_GATE_SEAMS.has(s))
  }
})

test('paired gain counts rescue/regress and bootstrap lower bound', () => {
  const g = pairedGain([
    { taskId: 't1', baseline: false, candidate: true },
    { taskId: 't2', baseline: false, candidate: true },
    { taskId: 't3', baseline: false, candidate: false },
    { taskId: 't4', baseline: true, candidate: true },
  ])
  assert.deepEqual(g.rescued.sort(), ['t1', 't2'])
  assert.deepEqual(g.regressed, [])
  assert.deepEqual(g.stillFailed, ['t3'])
  assert.equal(g.netLiftPp, 50) // 2/4 → 3/4 = +25pp? baseline 1/4=25%, candidate 3/4=75% → +50pp
  // bootstrap null below minimum sample
  assert.equal(bootstrapLiftPp([{ taskId: 'a', baseline: false, candidate: true }]), null)
})

test('pareto frontier drops dominated points', () => {
  const front = paretoFrontier([
    { id: 'a', successRate: 0.5, cost: 100 },
    { id: 'b', successRate: 0.5, cost: 120 }, // dominated by a
    { id: 'c', successRate: 0.8, cost: 150 }, // frontier
  ])
  assert.ok(front.has('a'))
  assert.ok(front.has('c'))
  assert.ok(!front.has('b'))
})

test('applying a prompt card injects guide text without changing DSL behavior', () => {
  const card: ChangeCard = {
    cardId: 'c1', clusterId: 'cl1', createdAt: 'x',
    surface: 'prompt', seam: 'guides', title: 't', nl: 'n',
    promptDiff: { guides: '请先澄清再作答。', guideStyle: 'style-rules' },
    middlewareDiff: null, mountDiff: null,
    surfaceReason: '', inTable: true, predictedGainPp: null, hardGate: false,
    status: 'proposed', verdict: 'pending', llmPrompt: null, llmOutput: null,
    proposalSource: 'llm',
  }
  const out = applyCardToConfig(card, BASE_CONFIG, {})
  assert.equal(out.config.guides, 'style-rules')
  assert.equal(out.config.selfVerify, 'off') // DSL untouched
  assert.equal(out.mounts.customGuideText, '请先澄清再作答。')
})

test('applying a middleware card turns on the deterministic control', () => {
  const card: ChangeCard = {
    cardId: 'c2', clusterId: 'cl1', createdAt: 'x',
    surface: 'middleware', seam: 'selfVerify', title: 't', nl: 'n',
    promptDiff: null,
    middlewareDiff: { selfVerify: 'premature-victory-check' },
    mountDiff: null,
    surfaceReason: '', inTable: true, predictedGainPp: null, hardGate: false,
    status: 'proposed', verdict: 'pending', llmPrompt: null, llmOutput: null,
    proposalSource: 'template',
  }
  const out = applyCardToConfig(card, BASE_CONFIG, {})
  assert.equal(out.config.selfVerify, 'premature-victory-check')
  assert.equal(out.mounts.customGuideText, undefined)
})

test('capabilityAlreadyOn detects already-enabled controls', () => {
  const on = cfg({ selfVerify: 'premature-victory-check' })
  assert.equal(capabilityAlreadyOn(on, {}, { selfVerify: 'premature-victory-check' }, {}), true)
  assert.equal(capabilityAlreadyOn(BASE_CONFIG, {}, { selfVerify: 'premature-victory-check' }, {}), false)
})

test('clustering is deterministic on tag × seam', () => {
  useLiveDbPath(':memory:')
  const failEvent = (step: number, mast: string) => ({ type: 'failure.tag', step, mast, confidence: 0.9, note: '', author: 'narrator' })
  const mk = (runId: string, mast: string) => ({
    runId, taskId: runId.toUpperCase(), taskTitle: 't', domain: 'general', split: 'repair',
    success: false, events: [failEvent(2, mast)], failureTags: [mast], createdAt: runId,
  }) as never
  const a = clusterRuns([mk('r1', 'premature-victory'), mk('r2', 'premature-victory'), mk('r3', 'fabricated-citation')])
  assert.equal(a.length, 2)
  assert.equal(a[0]!.count, 2)
  assert.equal(a[0]!.tag, 'premature-victory')
  assert.deepEqual(a[0]!.criticalSteps, [2, 2])
  // Deterministic: same input → same ids.
  const b = clusterRuns([mk('r1', 'premature-victory'), mk('r2', 'premature-victory'), mk('r3', 'fabricated-citation')])
  assert.equal(a[0]!.clusterId, b[0]!.clusterId)
})

test('gateStats computes paired gate success, lift, regression and fixed', () => {
  const pairs = [
    { taskId: 'g1', baseline: true, candidate: true },   // survived
    { taskId: 'g2', baseline: true, candidate: false },  // regressed
    { taskId: 'g3', baseline: false, candidate: true },  // fixed
    { taskId: 'g4', baseline: false, candidate: false }, // still failed
  ]
  const s = gateStats(pairs)
  assert.equal(s.baselinePass, 2)
  assert.equal(s.candidatePass, 2)
  assert.equal(s.baselinePassPp, 50)
  assert.equal(s.candidatePassPp, 50)
  assert.equal(s.gateLiftPp, 0)
  assert.deepEqual(s.regressed, ['g2'])
  assert.deepEqual(s.fixed, ['g3'])
  // A pure improvement: candidate lifts 25%.
  const up = gateStats([
    { taskId: 'a', baseline: true, candidate: true },
    { taskId: 'b', baseline: true, candidate: true },
    { taskId: 'c', baseline: false, candidate: true },
    { taskId: 'd', baseline: false, candidate: false },
  ])
  assert.equal(up.gateLiftPp, 25)
  assert.equal(up.regressed.length, 0)
})

function mkCard(partial: Partial<ChangeCard>): ChangeCard {
  return {
    cardId: 'card',
    clusterId: 'cluster',
    createdAt: '',
    surface: 'middleware',
    seam: 's',
    title: 't',
    nl: 'n',
    promptDiff: null,
    middlewareDiff: null,
    mountDiff: null,
    surfaceReason: '',
    inTable: true,
    predictedGainPp: 0,
    hardGate: false,
    status: 'proposed',
    verdict: 'pending',
    llmPrompt: null,
    llmOutput: null,
    proposalSource: 'template',
    ...partial,
  } as ChangeCard
}

test('chooseAutoCard respects slider, hard gates, out-of-table and picks top gain', () => {
  const hard = mkCard({ cardId: 'hard', hardGate: true, predictedGainPp: 90 })
  const off = mkCard({ cardId: 'off', inTable: false, predictedGainPp: 80 })
  const human = mkCard({ cardId: 'human', verdict: 'needs-human', predictedGainPp: 70 })
  const low = mkCard({ cardId: 'low', predictedGainPp: 10 })
  const high = mkCard({ cardId: 'high', predictedGainPp: 40 })
  const pool = [hard, off, human, low, high]
  // Level 0: nothing auto-applies.
  assert.equal(chooseAutoCard(pool, 0), null)
  // Level 1+: hard / off-table / human cards are excluded; highest gain wins.
  const pick = chooseAutoCard(pool, 1)
  assert.equal(pick?.cardId, 'high')
  // A screening/applied card is not eligible.
  assert.equal(chooseAutoCard([mkCard({ cardId: 'x', status: 'applied', predictedGainPp: 99 })], 1), null)
})

test('termination condition is exactly two consecutive no-lift generations', () => {
  assert.equal(reachedNoLiftStop(0), false)
  assert.equal(reachedNoLiftStop(1), false)
  assert.equal(reachedNoLiftStop(NO_LIFT_LIMIT), true)
  assert.equal(NO_LIFT_LIMIT, 2)
})

// ── §3.2 gate ×repeats ─────────────────────────────────────────────────────

test('gate repeats follow §3.2: 1 at temperature 0, 3 otherwise, override clamped', () => {
  assert.equal(gateRepeatsFor(0), 1)
  assert.equal(gateRepeatsFor(0.2), GATE_REPEATS_SUGGESTED)
  assert.equal(GATE_REPEATS_SUGGESTED, 3)
  // Explicit override wins but cannot fan out unboundedly.
  assert.equal(gateRepeatsFor(0.2, 5), 5)
  assert.equal(gateRepeatsFor(0.2, 99), GATE_REPEATS_MAX)
  assert.equal(gateRepeatsFor(0.2, 0), 1)
  assert.equal(gateRepeatsFor(0.2, -3), 1)
})

// ── §7.2④ top-N side-by-side race + Pareto pick ────────────────────────────

test('slider 0 races every proposed card, slider ≥1 keeps the auto-eligible filter', () => {
  const hard = mkCard({ cardId: 'hard', hardGate: true, predictedGainPp: 90 })
  const off = mkCard({ cardId: 'off', inTable: false, predictedGainPp: 80 })
  const high = mkCard({ cardId: 'high', predictedGainPp: 40 })
  const low = mkCard({ cardId: 'low', predictedGainPp: 10 })
  const pool = [low, off, hard, high]

  // Level 0: the race only picks, it never applies, so hard/out-of-table cards
  // may still be compared — the winner then waits for a human (§7.5).
  assert.deepEqual(chooseRaceCards(pool, 0, 4).map((c) => c.cardId), ['hard', 'off', 'high', 'low'])
  // Default width is the §7.2④ top-2.
  assert.deepEqual(chooseRaceCards(pool, 0).map((c) => c.cardId), ['hard', 'off'])
  // Level ≥1: the winner is applied by the gate, so only auto-eligible cards race.
  assert.deepEqual(chooseRaceCards(pool, 1).map((c) => c.cardId), ['high', 'low'])
  assert.deepEqual(chooseRaceCards(pool, 2, 1).map((c) => c.cardId), ['high'])
  assert.deepEqual(chooseTopCards(pool, 1).map((c) => c.cardId), ['high', 'low'])
})

test('Pareto pick prefers more success, then less cost, and never a regressed card', () => {
  const winner = pickParetoWinner([
    { id: 'cheap-bad', successRate: 0.4, cost: 1, regressed: 0 },
    { id: 'best', successRate: 0.8, cost: 3, regressed: 0 },
    { id: 'same-success-costlier', successRate: 0.8, cost: 5, regressed: 0 },
    { id: 'best-but-regressed', successRate: 0.95, cost: 1, regressed: 2 },
  ])
  assert.equal(winner, 'best')
  // Nothing left once every candidate regressed.
  assert.equal(pickParetoWinner([{ id: 'x', successRate: 0.9, cost: 1, regressed: 1 }]), null)
  assert.equal(pickParetoWinner([]), null)
})

test('a job left running by a dead process is reported as interrupted, not running', () => {
  const mine = { running: true, phase: 'x', bootId: BOOT_ID }
  const foreign = { running: true, phase: 'x', bootId: 'boot-other' }
  const legacy = { running: true, phase: 'x' }
  // Same epoch: untouched.
  assert.deepEqual(staleGuard(mine, {}), mine)
  // Different epoch or no epoch at all: the work is gone, so say so instead of
  // leaving the UI polling a job nobody is executing.
  assert.equal(staleGuard(foreign, { phase: 'interrupted' })?.running, false)
  assert.equal(staleGuard(legacy, { phase: 'interrupted' })?.running, false)
  // A finished job is never rewritten.
  assert.deepEqual(staleGuard({ running: false, bootId: 'boot-other' }, {}), { running: false, bootId: 'boot-other' })
  assert.equal(staleGuard(null as never, {}), null)
})

test('Pareto cost axis is USD first, token proxy second, and never Infinity', () => {
  assert.equal(paretoAxisOf({ avgCostUsd: 0.02, avgTokens: 9000 }), 'usd')
  assert.equal(paretoAxisOf({ avgCostUsd: null, avgTokens: 9000 }), 'token')
  assert.equal(paretoAxisOf({ avgCostUsd: null, avgTokens: null }), 'none')
  assert.equal(paretoCostOf({ avgCostUsd: 0.02, avgTokens: 9000 }), 0.02)
  assert.equal(paretoCostOf({ avgCostUsd: null, avgTokens: 9000 }), 9000)
  // An infinite cost would disqualify every candidate and leave no winner.
  assert.ok(Number.isFinite(paretoCostOf({})))
})
