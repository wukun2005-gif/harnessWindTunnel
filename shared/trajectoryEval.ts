// F7 Trajectory Evaluation — deterministic evaluator (dev-plan v1.2 §3.3/§3.4).
// Pure functions only: no Node APIs, no React, no network, no clock. Same
// (event stream, contract version) ⇒ byte-identical verdict (F7-8 可复算).
//
// Fixed evaluation order (§3.3): contract → per-step verdicts → first
// divergence (prefix feasibility) → aggregate metrics. Never the reverse.
import type { HarnessEvent } from './events'
import {
  ONE_STEP_CSR_MIN,
  type AllowedPath,
  type CheckpointResult,
  type EvidenceItem,
  type NormalizedStep,
  type NormalizedTrace,
  type Observable,
  type ReasonCode,
  type Severity,
  type StepVerdict,
  type TrajectoryCell,
  type TrajectoryContract,
  type TrajectorySource,
  type TrajectoryVerdictDetail,
} from './trajectory'

// ---------------------------------------------------------------------------
// D3 — adapter: three sources (scenario branches / domain traces / imported)
// normalized into one step sequence. Step grouping matches the Run Insight
// lanes (deriveRun): events carry a `step` field; step-less events are placed
// by timestamp into the bracketing step (run.started → prelude, run.finished
// → terminal).
export function normalizeTrace(events: HarnessEvent[], source: TrajectorySource, runId = events[0]?.runId ?? ''): NormalizedTrace {
  const buckets = new Map<number, NormalizedStep>()
  let terminal: NormalizedTrace['terminal'] = null
  let start: NormalizedTrace['start'] = null
  const loose: HarnessEvent[] = []

  for (const e of events) {
    if (e.type === 'run.started') { start = e; continue }
    if (e.type === 'run.finished') { terminal = e; continue }
    const step = (e as { step?: number }).step
    if (typeof step === 'number') {
      const b = buckets.get(step) ?? { step, events: [], primaryEventId: '' }
      if (b.events.length === 0) b.primaryEventId = e.type === 'model.request' ? e.id : b.primaryEventId
      if (!b.primaryEventId) b.primaryEventId = e.id
      b.events.push(e)
      buckets.set(step, b)
    } else {
      loose.push(e) // e.g. harness.mutation — placed by timestamp below
    }
  }

  for (const e of loose) {
    const after = [...buckets.values()].filter((b) => b.events[0] && b.events[0].ts <= e.ts).sort((a, b) => b.step - a.step)[0]
    if (after) after.events.push(e) // tail events without a step land in the bracketing bucket
  }

  const steps = [...buckets.values()].sort((a, b) => a.step - b.step)
  return { runId, source, steps, terminal, start, truncated: terminal === null }
}

// ---------------------------------------------------------------------------
// Observable matching. failure.tag is unmatchable by design (narrator labels
// are circumstantial evidence — §7.2 guardrail).
//
// Match predicates live on the KEY suffix: "tool": exact, "argsSummary~=":
// contains, "thought^=": startsWith, "route!=": differs, "scope!~": not
// contains. When `anyOf` is present it is the ONLY matcher — the top-level
// eventTypes/match act as a type union for documentation, so a broad base
// shape can never silently match every event.
function predPass(value: unknown, key: string, pred: string): boolean {
  // Nested payloads (e.g. model.request.blocks) are compared by their JSON
  // text: a contract can ask "did the tool schema offer patent_law" without
  // binding to a nested path.
  const s =
    typeof value === 'string'
      ? value
      : value === undefined || value === null
        ? undefined
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value)
  if (s === undefined) return false
  if (key.endsWith('>=') || key.endsWith('<=') || key.endsWith('>') || key.endsWith('<')) {
    const a = Number(s)
    const b = Number(pred)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    if (key.endsWith('>=')) return a >= b
    if (key.endsWith('<=')) return a <= b
    if (key.endsWith('>')) return a > b
    return a < b
  }
  if (key.endsWith('~=')) return s.includes(pred)
  if (key.endsWith('^=')) return s.startsWith(pred)
  if (key.endsWith('!~')) return !s.includes(pred)
  if (key.endsWith('!=')) return s !== pred
  if (key.endsWith('=')) return s === pred
  return s === pred
}

export function eventMatches(obs: Observable, e: HarnessEvent): boolean {
  if (e.type === 'failure.tag') return false
  if (obs.anyOf && obs.anyOf.length > 0) return obs.anyOf.some((alt) => eventMatches(alt, e))
  return (
    (obs.eventTypes as readonly string[]).includes(e.type) &&
    Object.entries(obs.match ?? {}).every(([k, v]) => predPass((e as unknown as Record<string, unknown>)[k.replace(/(>=|<=|!~|~=|\^=|!=|>|<|=)$/, '')], k, v))
  )
}

// ---------------------------------------------------------------------------
// Blocked-and-correct detection (§3.3 rule 2): a tool call followed by a gate
// denial (permission.denied / router REFUSE / hook deny) with no successful
// tool.result in between is POSITIVE evidence, not a violation. Only a
// privileged action that actually EXECUTES counts as violating (TCV note).
function isBlockedCall(flat: HarnessEvent[], callIdx: number): boolean {
  const call = flat[callIdx]
  if (call.type !== 'tool.call') return false
  for (let j = callIdx + 1; j < flat.length; j++) {
    const e = flat[j]
    if (e.type === 'tool.result' && e.tool === call.tool) return false // executed
    if (e.type === 'permission.denied' && e.scope.includes(call.tool)) return true
    if (e.type === 'router.decision' && e.tool === call.tool && e.route === 'REFUSE') return true
    if (e.type === 'hook.decision' && e.verdict === 'deny' && (e as { step?: number }).step === call.step) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Evaluator
interface CpState {
  id: string
  kind: 'required' | 'optional'
  completedIdx: number | null
  completedAtStep: number | null
  evidenceId: string | null
  windowClosedIdx: number | null
  windowClosedAtStep: number | null
  windowLabel?: string
  unknown: boolean
  /** Contract capability gate observed in the stream (false = not applicable). */
  applies: boolean
  /** Valid completion: inside its window, when a window is declared. */
  passed: boolean
}

export function evaluateTrace(contract: TrajectoryContract, trace: NormalizedTrace): TrajectoryVerdictDetail {
  // flat = all step events in order, then the terminal event. stepOfIdx maps
  // flat positions to step numbers (the terminal maps to the last step).
  const flat: HarnessEvent[] = [...trace.steps.flatMap((s) => s.events)]
  if (trace.terminal) flat.push(trace.terminal)
  const stepOfIdx = new Map<number, number>()
  let cursor = 0
  for (const s of trace.steps) {
    for (const _e of s.events) stepOfIdx.set(cursor++, s.step)
  }
  if (trace.terminal) stepOfIdx.set(cursor, trace.steps.length ? trace.steps[trace.steps.length - 1].step : 0)
  const stepAt = (idx: number): number => stepOfIdx.get(idx) ?? 0

  // ---- Checkpoint detection -------------------------------------------------
  const cps = new Map<string, CpState>()
  const observedEventTypes = new Set(flat.map((e) => e.type))
  for (const cp of contract.checkpoints) {
    let completedIdx: number | null = null
    let evidenceId: string | null = null
    for (let i = 0; i < flat.length; i++) {
      if (eventMatches(cp.observable, flat[i])) { completedIdx = i; evidenceId = flat[i].id; break }
    }
    let windowClosedIdx: number | null = null
    if (cp.window) {
      for (let i = 0; i < flat.length; i++) {
        if (eventMatches(cp.window.closesWith, flat[i])) { windowClosedIdx = i; break }
      }
    }
    // Capability gate: a checkpoint whose capability is not in the stream is
    // unobservable, not failed. This is the difference between "the agent
    // skipped the audit" and "this harness has no auditor" (ADR-09).
    const applies = !cp.appliesWhen || flat.some((e) => eventMatches(cp.appliesWhen as Observable, e))
    const inWindow = windowClosedIdx === null || completedIdx === null || completedIdx < windowClosedIdx
    // Unknown = evidence domain missing: a truncated stream, an import whose
    // stream never carries any of the observable's event types, or a capability
    // the harness never mounted. Never 0, never "not executed" (§3.3 rule 5).
    const domainMissing = trace.source === 'imported' && cp.observable.eventTypes.every((t) => !observedEventTypes.has(t))
    const unknown = !completedIdx && (trace.truncated || domainMissing || !applies)
    cps.set(cp.id, {
      id: cp.id, kind: cp.kind, completedIdx, completedAtStep: completedIdx !== null ? stepAt(completedIdx) : null,
      evidenceId, windowClosedIdx, windowClosedAtStep: windowClosedIdx !== null ? stepAt(windowClosedIdx) : null,
      windowLabel: cp.window?.label, unknown, applies, passed: completedIdx !== null && inWindow,
    })
  }

  // ---- Forbidden actions ----------------------------------------------------
  interface Vio { step: number; idx: number; severity: Severity; ruleId: string; evidenceId: string }
  const violations: Vio[] = []
  const blockedIdx = new Set<number>()
  for (const fa of contract.forbiddenActions) {
    // A rule whose capability is absent is not judged: no auditor mounted means
    // the submission cannot be called unaudited.
    if (fa.appliesWhen && !flat.some((e) => eventMatches(fa.appliesWhen as Observable, e))) continue
    for (let i = 0; i < flat.length; i++) {
      if (!eventMatches(fa.observable, flat[i])) continue
      if (isBlockedCall(flat, i)) { blockedIdx.add(i); continue } // blocked-and-correct: positive evidence
      if (fa.requires) {
        let ok = false
        for (let j = 0; j < i; j++) { if (eventMatches(fa.requires.observable, flat[j])) { ok = true; break } }
        if (ok) continue // precondition met → allowed action
      }
      violations.push({ step: stepAt(i), idx: i, severity: fa.severity, ruleId: fa.id, evidenceId: flat[i].id })
    }
  }
  const hardViolation = violations.some((v) => v.severity === 'hard')
  const softViolations = violations.filter((v) => v.severity === 'soft').length
  const hardIdxs = violations.filter((v) => v.severity === 'hard').map((v) => v.idx)

  // ---- Path aliveness (prefix feasibility) → first divergence ---------------
  // firstDivergence is the step at which the LAST allowed path died (§3.3 rule
  // 3: the earliest step from which NO path can still reach completion) — not
  // the first individual path death.
  const alive = new Map<string, boolean>(contract.allowedPaths.map((p) => [p.id, true]))
  let aliveCount = contract.allowedPaths.length
  let divergence: { step: number; code: 'hard-kill' | 'edge-violated' | 'window-closed'; ref: string } | null = null
  const killPath = (pid: string, step: number, code: 'hard-kill' | 'edge-violated' | 'window-closed', ref: string) => {
    if (!alive.get(pid)) return
    alive.set(pid, false)
    aliveCount -= 1
    if (aliveCount === 0) divergence = { step, code, ref }
  }
  const killAll = (step: number, code: 'hard-kill' | 'edge-violated' | 'window-closed', ref: string) => {
    for (const pid of [...alive.keys()]) killPath(pid, step, code, ref)
  }
  const orderedCpCompletions = [...cps.values()]
    .filter((c) => c.completedIdx !== null)
    .sort((a, b) => (a.completedIdx as number) - (b.completedIdx as number))

  // Replay completion/window events in stream order; a path dies the moment one
  // of its constraints becomes unsatisfiable from the prefix.
  const timeline: Array<{ idx: number; kind: 'complete' | 'window' | 'hard'; cpId?: string }> = []
  for (const c of orderedCpCompletions) timeline.push({ idx: c.completedIdx as number, kind: 'complete', cpId: c.id })
  for (const c of [...cps.values()].filter((c) => c.windowClosedIdx !== null)) timeline.push({ idx: c.windowClosedIdx as number, kind: 'window', cpId: c.id })
  for (const i of hardIdxs) timeline.push({ idx: i, kind: 'hard' })
  timeline.sort((a, b) => a.idx - b.idx)

  for (const ev of timeline) {
    const step = stepAt(ev.idx)
    if (ev.kind === 'hard') { killAll(step, 'hard-kill', ''); continue }
    const c = cps.get(ev.cpId as string)!
    if (ev.kind === 'window') {
      if (!c.applies) continue // capability absent → the window never opened
      for (const p of contract.allowedPaths) {
        if (!alive.get(p.id)) continue
        const depends = p.nodes.includes(c.id) && (cps.get(c.id)?.kind === 'required')
        const missed = c.completedIdx === null || (c.completedIdx as number) > (c.windowClosedIdx ?? Number.MAX_SAFE_INTEGER)
        if (depends && missed) killPath(p.id, step, 'window-closed', c.id)
      }
      continue
    }
    // completion: ordering edges (A must precede B) judged by event index
    for (const p of contract.allowedPaths) {
      if (!alive.get(p.id)) continue
      for (const [a, b] of p.edges) {
        if (b !== c.id) continue
        const A = cps.get(a)!
        // An edge into a capability that was never mounted cannot be violated.
        if (!A.applies) continue
        if (A.completedIdx === null || (A.completedIdx as number) > (c.completedIdx as number)) {
          killPath(p.id, step, 'edge-violated', `${a}>${b}`)
        }
      }
    }
  }
  const firstDivergence = divergence ? (divergence as { step: number }).step : null
  const divergenceReason = divergence ? `${(divergence as { code: string; ref: string }).code}:${(divergence as { ref: string }).ref}` : null

  // ---- Per-step verdicts (priority: violating > recovering > required > redundant > neutral)
  // Incidents open the recovery window: soft violations and gate rejections
  // (sensor.lint reject / verifier.verdict reject) — §3.3 rule 4.
  interface Incident { idx: number; step: number }
  const incidents: Incident[] = []
  flat.forEach((e, i) => {
    if (e.type === 'sensor.lint' && e.verdict === 'reject') incidents.push({ idx: i, step: stepAt(i) })
    if (e.type === 'verifier.verdict' && e.verdict === 'reject') incidents.push({ idx: i, step: stepAt(i) })
  })
  for (const v of violations) if (v.severity === 'soft') incidents.push({ idx: v.idx, step: v.step })

  // Missing evidence (truncated stream / import without the evidence domain)
  // keeps neutral steps "unknown" instead of asserting they were fine.
  const anyRequiredUnknown = [...cps.values()].some((c) => c.kind === 'required' && c.unknown)

  const stepVerdicts: StepVerdict[] = trace.steps.map((s) => {
    const evid = s.events.map((e) => e.id)
    const vios = violations.filter((v) => v.step === s.step)
    const blockedHere = [...blockedIdx].some((i) => stepAt(i) === s.step)

    // checkpoints completed within THIS step (by event index inside the step)
    const completedHere = [...cps.values()].filter((c) => c.completedIdx !== null && stepAt(c.completedIdx as number) === s.step)

    if (vios.length > 0) {
      const hard = vios.find((v) => v.severity === 'hard')
      const v = hard ?? vios[0]
      return { step: s.step, verdict: 'violating', evidenceIds: [v.evidenceId], reason: 'forbidden-executed', severity: v.severity, ruleId: v.ruleId }
    }

    // recovery: a checkpoint re-established inside the window after an incident
    // (soft violation or gate rejection), with no hard violation in between.
    const k = contract.recoveryWindow
    for (const c of completedHere) {
      const inc = incidents.find(
        (a) =>
          a.idx < (c.completedIdx as number) &&
          stepAt((c.completedIdx as number)) - a.step <= k &&
          stepAt((c.completedIdx as number)) - a.step > 0 &&
          !hardIdxs.some((h) => a.idx < h && h < (c.completedIdx as number)),
      )
      if (inc) {
        return { step: s.step, verdict: 'recovering', evidenceIds: [c.evidenceId as string], reason: 'recovery', ruleId: c.id }
      }
    }

    const reqHere = completedHere.filter((c) => c.kind === 'required' && c.passed)
    if (reqHere.length > 0) {
      return { step: s.step, verdict: 'required', evidenceIds: reqHere.map((c) => c.evidenceId as string), reason: 'checkpoint-advanced', ruleId: reqHere.map((c) => c.id).join('+') }
    }

    const base: StepVerdict = { step: s.step, verdict: 'neutral', evidenceIds: evid.slice(0, 1), reason: 'neutral' }
    if (blockedHere) base.blockedCorrect = true
    if (trace.truncated || anyRequiredUnknown) base.unknown = true
    return base
  })

  // Redundancy pass: identical tool+thought fingerprints on earlier steps.
  const seenFp = new Set<string>()
  for (let i = 0; i < trace.steps.length; i++) {
    const fp = fingerprint(trace.steps[i])
    if (stepVerdicts[i].verdict === 'neutral' && seenFp.has(fp)) {
      stepVerdicts[i] = { step: trace.steps[i].step, verdict: 'redundant', evidenceIds: stepVerdicts[i].evidenceIds, reason: 'redundant-repeat' }
    }
    seenFp.add(fp)
  }
  // blocked-correct flag survives the redundancy rewrite
  for (let i = 0; i < trace.steps.length; i++) {
    const s = trace.steps[i]
    if ([...blockedIdx].some((bi) => stepAt(bi) === s.step)) stepVerdicts[i].blockedCorrect = true
  }

  // ---- Metrics (§3.4) --------------------------------------------------------
  const required = contract.checkpoints.filter((cp) => cp.kind === 'required')
  const requiredUnknown = required.filter((cp) => cps.get(cp.id)?.unknown).length
  const requiredPassed = required.filter((cp) => cps.get(cp.id)?.passed).length
  const csrDenom = required.length - requiredUnknown
  const csr = csrDenom > 0 ? requiredPassed / csrDenom : null // unknown never enters the denominator

  const anyAlive = [...alive.values()].some(Boolean)
  const pvr = contract.allowedPaths.length >= 2 ? (anyAlive ? 1 : 0) : null

  const totalCalls = flat.filter((e) => e.type === 'tool.call').length
  const illegalCalls = new Set(violations.filter((v) => flat[v.idx]?.type === 'tool.call').map((v) => v.idx)).size
  const tcv = totalCalls > 0 ? (totalCalls - illegalCalls) / totalCalls : null

  const fps = trace.steps.map(fingerprint)
  const redundancy = trace.steps.length > 0 ? 1 - new Set(fps).size / trace.steps.length : null

  const recovering = stepVerdicts.some((v) => v.verdict === 'recovering')
  const success = trace.terminal ? trace.terminal.success : null
  const recovery = incidents.length > 0 ? (recovering && success === true ? 1 : 0) : null

  const requiredSteps = stepVerdicts.filter((v) => v.verdict === 'required' || v.verdict === 'recovering').length
  const pe = csr === 1 && trace.steps.length > 0 ? requiredSteps / trace.steps.length : null // PE only after CSR is complete (§3.4)

  // ---- Four-cell read (§F7-3): process × terminal, neither overwrites the other.
  // A missing evidence domain blocks the process cell: no conclusion is better
  // than a "trusted success" built on an absent stream (§3.3 rule 5).
  const illegal = firstDivergence !== null || hardViolation
  // Success with process evidence missing: the run never did a required step,
  // so calling it "trusted" would launder an incomplete process. Keep the cell
  // open and expose the disagreement explicitly. Checkpoints whose capability
  // was never mounted are NOT counted as missing here — that is missing
  // evidence, and it keeps the cell open as "unknown" instead.
  const requiredMissing = required.length - requiredPassed - requiredUnknown
  const processIncomplete = success === true && !illegal && requiredMissing > 0
  let cell: TrajectoryCell | null = null
  if (success !== null && requiredUnknown === 0) {
    if (!illegal) {
      if (!success) cell = csr !== null && csr >= ONE_STEP_CSR_MIN ? 'one-step-short' : 'clear-failure'
      else cell = processIncomplete ? null : 'trusted-success'
    } else cell = success ? 'fluke-success' : 'clear-failure'
  }

  // Walk signature: the order the checkpoints actually completed. Used by the
  // stability panel to report path concentration — never by a score.
  const walked = [...cps.values()].filter((c) => c.completedIdx !== null).sort((a, b) => (a.completedIdx as number) - (b.completedIdx as number))
  const pathSignature = walked.length > 0 ? walked.map((c) => c.id).join('>') : 'none'
  const matchedPath =
    contract.allowedPaths.find((p) => {
      const nodesOk = p.nodes.every((n) => cps.get(n)?.kind !== 'required' || cps.get(n)?.completedIdx !== null)
      if (!nodesOk) return false
      return p.edges.every(([a, b]) => {
        const A = cps.get(a)
        const B = cps.get(b)
        if (!A || !B) return false
        if (A.completedIdx === null || B.completedIdx === null) return true // optional hop not taken
        return (A.completedIdx as number) < (B.completedIdx as number)
      })
    })?.id ?? null

  const checkpointResults: CheckpointResult[] = contract.checkpoints.map((cp) => {
    const c = cps.get(cp.id)!
    return {
      id: c.id, kind: c.kind, completed: c.passed, unknown: c.unknown, applies: c.applies, evidenceEventId: c.evidenceId,
      completedAtStep: c.completedAtStep, windowClosedAtStep: c.windowClosedAtStep, windowLabel: c.windowLabel,
    }
  })

  // Evidence trail: every verdict-bearing event with its own prose.
  const evidence: EvidenceItem[] = []
  for (const v of violations) {
    const ev = flat[v.idx]
    evidence.push({ eventId: v.evidenceId, step: v.step, kind: 'violation', ref: v.ruleId, text: eventText(ev), ...(ev.type === 'legal.assertion' ? { label: ev.label } : {}) })
  }
  for (const i of [...blockedIdx].sort((a, b) => a - b)) {
    const ev = flat[i]
    if (ev.type === 'tool.call') evidence.push({ eventId: ev.id, step: stepAt(i), kind: 'blocked', ref: ev.tool, text: eventText(ev) })
  }
  for (const c of cps.values()) {
    if (c.completedIdx === null) continue
    evidence.push({ eventId: c.evidenceId as string, step: c.completedAtStep as number, kind: 'checkpoint', ref: c.id, text: eventText(flat[c.completedIdx]) })
  }
  evidence.sort((a, b) => a.step - b.step || a.eventId.localeCompare(b.eventId))

  return {
    runId: trace.runId,
    contractId: contract.contractId,
    contractVersion: contract.version,
    source: trace.source,
    steps: stepVerdicts,
    firstDivergence,
    divergenceReason,
    csr,
    hardViolation,
    softViolations,
    cell,
    metrics: { pvr, tcv, redundancy, recovery, pe },
    checkpoints: checkpointResults,
    terminalSuccess: success,
    processIncomplete,
    evidence,
    pathCount: contract.allowedPaths.length,
    recoveryWindow: contract.recoveryWindow,
    stepsCount: trace.steps.length,
    pathSignature,
    matchedPath,
  }
}

function fingerprint(s: NormalizedStep): string {
  const tools = s.events.filter((e): e is Extract<HarnessEvent, { type: 'tool.call' }> => e.type === 'tool.call').map((e) => `${e.tool}:${e.argsSummary}`)
  const thought = s.events.find((e): e is Extract<HarnessEvent, { type: 'model.response' }> => e.type === 'model.response')?.thought ?? ''
  return JSON.stringify([tools, thought])
}

/** The event's own prose, for evidence rows shown in the UI. */
export function eventText(e: HarnessEvent): string {
  switch (e.type) {
    case 'tool.call': return `${e.tool}(${e.argsSummary})`
    case 'tool.result': return `${e.tool}: ${e.summary}`
    case 'model.response': return e.thought
    case 'legal.assertion': return e.claimText
    case 'permission.denied': return `${e.scope} — ${e.reason}`
    case 'permission.request': return `${e.scope} (${e.riskLevel})`
    case 'permission.granted': return `${e.scope} via ${e.via}`
    case 'router.decision': return `${e.tool} → ${e.route} (${e.matchedRule})`
    case 'hook.decision': return `${e.hook}: ${e.verdict} — ${e.reason}`
    case 'verifier.verdict': return `${e.verifier}: ${e.verdict} — ${e.reason}`
    case 'sensor.lint': return `${e.lint}: ${e.verdict} — ${e.reason}`
    default: return e.type
  }
}

/** Convenience: run the full pipeline over raw events (used by store + tests). */
export function evaluateEvents(contract: TrajectoryContract, events: HarnessEvent[], source: TrajectorySource): TrajectoryVerdictDetail {
  return evaluateTrace(contract, normalizeTrace(events, source))
}
