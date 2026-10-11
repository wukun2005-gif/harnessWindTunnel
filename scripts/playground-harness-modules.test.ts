import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cfg } from '../shared/config'
import type { HarnessEvent } from '../shared/events'
import { eventAttribution, moduleActivity } from '../src/screens/Playground/harnessModules'

/**
 * The strip exists to make "switch on but never wired" visible. These tests pin the
 * three states apart, because collapsing `idle` into either `fired` or "broken" is
 * exactly how a dead switch stays hidden.
 */

let n = 0
const base = (): { id: string; ts: number; runId: string; scenarioId: string; author: 'harness' } => ({
  id: `e${++n}`,
  ts: n,
  runId: 'r1',
  scenarioId: 's1',
  author: 'harness',
})

const toolCall = (tool: string): HarnessEvent =>
  ({ ...base(), type: 'tool.call', step: 1, tool, argsSummary: '{}' }) as HarnessEvent
const routerDecision = (matchedRule: string): HarnessEvent =>
  ({
    ...base(),
    type: 'router.decision',
    step: 1,
    tool: 't',
    route: matchedRule.startsWith('sandbox-') ? 'REFUSE' : 'EXECUTE',
    matchedRule,
    policyVersion: 'v1',
  }) as HarnessEvent
const modelRequest = (preview: boolean): HarnessEvent =>
  ({
    ...base(),
    type: 'model.request',
    step: 1,
    estTokens: 10,
    blocks: [{ layer: 'system', sourceComponent: 'runner', tokens: 10, positionIndex: 0, ...(preview ? { preview: 'x' } : {}) }],
  }) as HarnessEvent

const pick = (mods: ReturnType<typeof moduleActivity>, key: string) => mods.find((m) => m.key === key)

test('baseline config reports no modules at all', () => {
  assert.deepEqual(moduleActivity(cfg(), {}, []), [])
})

test('file-backed-state with no fs call is idle, not fired', () => {
  // The whole bug in one assertion: config says the switch is on, events say nothing
  // happened. That must be visible as `idle` — otherwise a dead switch looks active.
  const m = pick(moduleActivity(cfg({ filesystem: 'file-backed-state' }), {}, []), 'filesystem')
  assert.equal(m?.state, 'idle')
  assert.equal(m?.value, 'file-backed-state')
})

test('file-backed-state fires once the model opens a file', () => {
  const m = pick(
    moduleActivity(cfg({ filesystem: 'file-backed-state' }), {}, [toolCall('fs_list'), toolCall('fs_read')]),
    'filesystem',
  )
  assert.equal(m?.state, 'fired')
  assert.match(m!.evidence, /fs_/)
})

test('write barrier reads as idle when only reads were attempted', () => {
  // A read-only run under a write barrier is healthy. Calling that "not fired" and
  // leaving it there would push people to "fix" a switch that is working.
  const m = pick(moduleActivity(cfg({ sandbox: 'write-barrier' }), {}, [routerDecision('read-only-tool')]), 'sandbox')
  assert.equal(m?.state, 'idle')
  assert.match(m!.evidence, /read/)
})

test('write barrier fires when a write is refused', () => {
  const m = pick(
    moduleActivity(cfg({ sandbox: 'write-barrier' }), {}, [routerDecision('sandbox-write-barrier')]),
    'sandbox',
  )
  assert.equal(m?.state, 'fired')
})

test('observability fires only when requests carry a preview', () => {
  const off = pick(moduleActivity(cfg({ observability: 'trace' }), {}, [modelRequest(false)]), 'observability')
  assert.equal(off?.state, 'idle')
  const on = pick(moduleActivity(cfg({ observability: 'trace' }), {}, [modelRequest(true)]), 'observability')
  assert.equal(on?.state, 'fired')
})

test('prompt-only modules are marked as such, never as idle or fired', () => {
  // guides/selfVerify shape the system prompt; no event can ever prove them. Saying
  // "not fired" about them would be a false alarm, so they get their own state.
  const mods = moduleActivity(cfg({ guides: 'domain-checklist', selfVerify: 'premature-victory-check' }), {}, [])
  assert.equal(pick(mods, 'guides')?.state, 'prompt')
  assert.equal(pick(mods, 'selfVerify')?.state, 'prompt')
})

test('a mounted capability is listed even though it has no DSL field', () => {
  const mods = moduleActivity(cfg(), { patentLawMcp: true }, [])
  assert.equal(pick(mods, 'mount:patentLawMcp')?.state, 'idle')
  const fired = moduleActivity(cfg(), { patentLawMcp: true }, [toolCall('patent_law_search')])
  assert.equal(pick(fired, 'mount:patentLawMcp')?.state, 'fired')
})

test('C0 and C1 are distinguishable from the config alone, before any event', () => {
  // If these two produced the same strip, the strip would be useless for the exact
  // comparison it was built for. C1 now also shows derived security controls
  // (input-isolation from file-backed-state), making it even more distinct.
  const c0 = moduleActivity(cfg(), {}, [])
  const c1 = moduleActivity(cfg({ filesystem: 'file-backed-state' }), {}, [])
  assert.equal(c0.length, 0)
  assert.ok(c1.length > 1, 'C1 shows filesystem + derived controls')
})

// ── event attribution: which module caused this event ────────────────────────
//
// The trajectory lists what happened but not who did it. Attribution is what turns
// "harness did something" into "the file-backed switch did this", which is the only
// way a reader can tell two configs apart from their event streams.

const toolEv = (tool: string): HarnessEvent => ({ ...base(), type: 'tool.call', step: 1, tool, argsSummary: '{}' }) as HarnessEvent
const deniedEv = (gate: string): HarnessEvent =>
  ({ ...base(), type: 'permission.denied', step: 1, scope: 's', gate, reason: 'r' }) as HarnessEvent
const hookEv = (hook: string): HarnessEvent =>
  ({ ...base(), type: 'hook.decision', step: 1, hook, verdict: 'deny', reason: 'r' }) as HarnessEvent
const verifierEv = (): HarnessEvent =>
  ({ ...base(), type: 'verifier.verdict', step: 1, verifier: 'v', verdict: 'pass', reason: 'r' }) as HarnessEvent
const finishedEv = (): HarnessEvent =>
  ({ ...base(), type: 'run.finished', success: true, tokens: 1, latencyP50: 1, failureModes: {} }) as HarnessEvent

test('fs_* calls are credited to whichever knob created the workspace', () => {
  const backed = cfg({ filesystem: 'file-backed-state' })
  assert.equal(eventAttribution(toolEv('fs_read'), backed, {})?.key, 'filesystem')
  // Same tool, but the workspace came from the sandbox needing something writable.
  assert.equal(eventAttribution(toolEv('fs_read'), cfg({ sandbox: 'write-barrier' }), {})?.key, 'sandbox')
  // Neither knob on: a workspace should not exist, so nothing may claim the call.
  assert.equal(eventAttribution(toolEv('fs_read'), cfg(), {}), null)
})

test('the permission gate and the sandbox gate are attributed apart', () => {
  const perms = cfg({ permissions: 'deny-first' })
  assert.equal(eventAttribution(routerDecision('deny-nonpublic-case-materials'), perms, {})?.key, 'permissions')
  assert.equal(eventAttribution(deniedEv('permission-gate'), perms, {})?.key, 'permissions')
  const sandbox = cfg({ sandbox: 'write-barrier' })
  assert.equal(eventAttribution(routerDecision('sandbox-write-barrier'), sandbox, {})?.key, 'sandbox')
  assert.equal(eventAttribution(deniedEv('sandbox'), sandbox, {})?.key, 'sandbox')
})

test('runner bookkeeping is not attributed to a knob', () => {
  // Tool routing, the empty-answer record and posthoc failure tags run regardless of
  // config. Labelling them as some module's work would be a lie in the other direction.
  assert.equal(eventAttribution(routerDecision('read-only-tool'), cfg({ filesystem: 'file-backed-state' }), {}), null)
  assert.equal(eventAttribution(routerDecision('tool-not-mounted'), cfg(), {}), null)
  assert.equal(eventAttribution(finishedEv(), cfg({ sandbox: 'write-barrier' }), {}), null)
})

test('hooks and global policy are told apart by hook name', () => {
  const c3 = cfg({ hooks: 'lifecycle', globalPolicy: 'policy-enforced' })
  assert.equal(eventAttribution(hookEv('untrusted-input-wrap'), c3, {})?.key, 'hooks')
  assert.equal(eventAttribution(hookEv('egress-dlp'), c3, {})?.key, 'globalPolicy')
  assert.equal(eventAttribution(hookEv('empty-answer'), c3, {}), null)
})

test('the citation sensor owns both verdicts and assertions', () => {
  assert.equal(eventAttribution(verifierEv(), cfg({ sensors: 'verifier' }), {})?.key, 'sensors')
})

test('a traced request is credited to observability, an untraced one to nobody', () => {
  const traced = cfg({ observability: 'trace+mast' })
  assert.equal(eventAttribution(modelRequest(true), traced, {})?.key, 'observability')
  assert.equal(eventAttribution(modelRequest(false), cfg({ observability: 'trace' }), {}), null)
})

test('the mounted authority MCP owns its own tool calls', () => {
  assert.equal(eventAttribution(toolEv('patent_law_search'), cfg(), { patentLawMcp: true })?.key, 'mount:patentLawMcp')
  // Not mounted: a model that hallucinated the call does not get it attributed.
  assert.equal(eventAttribution(toolEv('patent_law_search'), cfg(), {}), null)
})
