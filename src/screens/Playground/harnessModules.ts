/**
 * Which harness modules were on for a run, and whether the event stream actually
 * shows them acting.
 *
 * The point is falsifiability. A run whose config says `filesystem=file-backed-state`
 * but whose trajectory contains no `fs_*` tool call is indistinguishable from a run
 * where the switch was never wired into the runner — that is exactly the bug that
 * sat undetected because nothing on screen connected "config says X" to "X happened".
 *
 * Three states, deliberately not two:
 *   fired  — an event proves the module acted
 *   prompt — the module only shapes the system prompt, so there is no event by design
 *   idle   — on, but this run gave it nothing to do (e.g. a write barrier with no write)
 *
 * `idle` must not read as failure: `sandbox=write-barrier` with no write attempted is
 * a healthy run, not a broken switch. Only `fired` is positive evidence; the config
 * line above it is what tells you the switch was requested at all.
 */
import { BASE_CONFIG, COMPONENT_META, type ConfigField, type HarnessConfig } from '../../../shared/config'
import type { HarnessEvent } from '../../../shared/events'
import type { PgMounts, ControlsSnapshot } from '../../../shared/playground'
import { SECURITY_CONTROLS, type SecurityControl, SECURITY_CONTROL_LABEL } from '../../../shared/redteam'
import { LEGAL_CONTROLS, type LegalControl, LEGAL_CONTROL_LABEL } from '../../../shared/legal'

export type ModuleState = 'fired' | 'prompt' | 'idle'

export interface ModuleActivity {
  /** Config field name, or `mount:patentLawMcp`, or `sec:input-isolation`, `leg:authority-mcp`. */
  key: string
  /** Module label from the DSL, e.g. "③ File System & State". */
  label: string
  /** The non-default value this run carried. */
  value: string
  state: ModuleState
  /** Short, factual note about the evidence (or its absence). */
  evidence: string
}

const count = (events: HarnessEvent[], pred: (e: HarnessEvent) => boolean): number =>
  events.reduce((n, e) => (pred(e) ? n + 1 : n), 0)

const plural = (n: number, one: string, many = `${one}s`): string => `${n} × ${n === 1 ? one : many}`

/** Replicate the server's controlsSnapshot logic (must stay in sync with presets.ts). */
function computeControlsSnapshot(config: HarnessConfig, mounts: PgMounts = {}): ControlsSnapshot {
  const security = {
    'input-isolation': config.hooks === 'lifecycle' || config.filesystem === 'file-backed-state',
    'tool-boundary-gateway': config.permissions !== 'open',
    'least-privilege-creds': config.sandbox !== 'off',
    'exec-sandbox': config.sandbox === 'write-barrier',
    'human-approval-gate': config.humanInLoop === 'approval-gates',
    'egress-dlp': config.globalPolicy === 'policy-enforced',
    'outofband-killswitch': config.hooks === 'lifecycle' && config.globalPolicy === 'policy-enforced',
  } as Record<SecurityControl, boolean>

  const legal = {
    'authority-mcp': mounts.patentLawMcp === true,
    'citation-audit': config.sensors === 'verifier' || config.sensors === 'verifier+critic',
    'deadline-ledger': config.planner !== 'off' && config.memory !== 'none',
    'jurisdiction-filter': config.guides === 'domain-checklist',
    'issue-close-gate': config.selfVerify === 'premature-victory-check',
    'risk-escalation-gate': config.humanInLoop !== 'none',
    'hash-audit-chain': config.observability === 'trace+mast',
  } as Record<LegalControl, boolean>

  return { security, legal }
}

export function moduleActivity(
  config: HarnessConfig,
  mounts: PgMounts | undefined,
  events: HarnessEvent[],
  controls?: ControlsSnapshot,
): ModuleActivity[] {
  const out: ModuleActivity[] = []
  const push = (field: ConfigField, state: ModuleState, evidence: string): void => {
    out.push({
      key: field,
      label: COMPONENT_META[field].label,
      value: String(config[field]),
      state,
      evidence,
    })
  }
  const pushDerived = (key: string, label: string, value: string, state: ModuleState, evidence: string): void => {
    out.push({ key, label, value, state, evidence })
  }

  // ── ③ File System & State ── the dossier moves into files the model opens on demand
  if (config.filesystem !== BASE_CONFIG.filesystem) {
    const n = count(events, (e) => e.type === 'tool.call' && e.tool.startsWith('fs_'))
    push('filesystem', n > 0 ? 'fired' : 'idle', n > 0 ? plural(n, 'tool.call fs_*', 'tool.call fs_*') : 'no fs_* call')
  }

  // ── ④ Execution Sandbox ── the barrier only shows up when something tries to write
  if (config.sandbox !== BASE_CONFIG.sandbox) {
    const barred = count(
      events,
      (e) =>
        (e.type === 'router.decision' && e.matchedRule.startsWith('sandbox-')) ||
        (e.type === 'permission.denied' && e.gate === 'sandbox'),
    )
    const gated = count(events, (e) => e.type === 'router.decision' && e.matchedRule === 'read-only-tool')
    push(
      'sandbox',
      barred > 0 ? 'fired' : 'idle',
      barred > 0
        ? `${plural(barred, 'refusal')}${gated > 0 ? ` · ${gated} read allowed` : ''}`
        : gated > 0
          ? `${plural(gated, 'read')} allowed · no write attempted`
          : 'no tool call reached the barrier',
    )
  }

  // ── ⑧ Context Compression ── fires only when the dossier overruns the budget
  if (config.compression !== BASE_CONFIG.compression) {
    const n = count(events, (e) => e.type === 'shaper.fire')
    push('compression', n > 0 ? 'fired' : 'idle', n > 0 ? plural(n, 'shaper.fire') : 'dossier within budget')
  }

  // ── ⑩ Lifecycle Hooks ── untrusted-input wrap on dossier-bearing questions
  if (config.hooks !== BASE_CONFIG.hooks) {
    const n = count(events, (e) => e.type === 'hook.decision' && e.hook === 'untrusted-input-wrap')
    push('hooks', n > 0 ? 'fired' : 'idle', n > 0 ? plural(n, 'hook.decision') : 'no dossier to isolate')
  }

  // ── ⑪ Permission Gate ── deterministic refusal of non-public case material
  if (config.permissions !== BASE_CONFIG.permissions) {
    const n = count(events, (e) => e.type === 'router.decision' && e.matchedRule === 'deny-nonpublic-case-materials')
    push('permissions', n > 0 ? 'fired' : 'idle', n > 0 ? plural(n, 'router.decision REFUSE') : 'question made no such request')
  }

  // ── ⑫ Feedforward Guidelines / ⑭ Self-Verification ── prompt-only, injected
  // into the system block of every model.request. The strip keeps the `prompt`
  // state (no event can prove a wording choice), but the evidence must name
  // where the injection landed so the reader can look at that step — "system
  // prompt only" with no pointer is exactly the unmarked work this strip exists
  // to prevent.
  if (config.guides !== BASE_CONFIG.guides) {
    const steps = events
      .filter((e) => e.type === 'model.request' && e.blocks.some((b) => b.layer === 'system'))
      .map((e) => (e as Extract<HarnessEvent, { type: 'model.request' }>).step)
    push(
      'guides',
      'prompt',
      steps.length > 0 ? `${plural(steps.length, 'system block')} · step ${steps.join(', ')}` : 'system prompt only',
    )
  }
  if (config.selfVerify !== BASE_CONFIG.selfVerify) {
    const steps = events
      .filter((e) => e.type === 'model.request' && e.blocks.some((b) => b.layer === 'system'))
      .map((e) => (e as Extract<HarnessEvent, { type: 'model.request' }>).step)
    push(
      'selfVerify',
      'prompt',
      steps.length > 0 ? `${plural(steps.length, 'system block')} · step ${steps.join(', ')}` : 'system prompt only',
    )
  }

  // ── ⑬ Feedback Sensors ── citation verifier verdicts
  if (config.sensors !== BASE_CONFIG.sensors) {
    const n = count(events, (e) => e.type === 'verifier.verdict')
    push('sensors', n > 0 ? 'fired' : 'idle', n > 0 ? plural(n, 'verifier.verdict') : 'no verdict reached the sensor')
  }

  // ── ⑮ Global Safety Policy ── egress DLP on the final answer + prompt injection
  if (config.globalPolicy !== BASE_CONFIG.globalPolicy) {
    const n = count(events, (e) => e.type === 'hook.decision' && e.hook === 'egress-dlp')
    const steps = events
      .filter((e) => e.type === 'model.request' && e.blocks.some((b) => b.layer === 'system'))
      .map((e) => (e as Extract<HarnessEvent, { type: 'model.request' }>).step)
    const promptNote = steps.length > 0 ? ` · ${plural(steps.length, 'system block')} · step ${steps.join(', ')}` : ''
    push('globalPolicy', n > 0 ? 'fired' : 'idle', (n > 0 ? plural(n, 'egress-dlp') : 'no sensitive field in output') + promptNote)
  }

  // ── ⑯ Observability ── trace attaches a preview to every context block
  if (config.observability !== BASE_CONFIG.observability) {
    const n = count(events, (e) => e.type === 'model.request' && e.blocks.some((b) => b.preview != null))
    push('observability', n > 0 ? 'fired' : 'idle', n > 0 ? plural(n, 'traced model.request') : 'no request logged')
  }

  // ── mounted capabilities have no DSL slot of their own ──
  if (mounts?.patentLawMcp) {
    const n = count(events, (e) => e.type === 'tool.call' && e.tool.startsWith('patent_law'))
    out.push({
      key: 'mount:patentLawMcp',
      label: 'Mount · patent-law-mcp',
      value: 'mounted',
      state: n > 0 ? 'fired' : 'idle',
      evidence: n > 0 ? plural(n, 'tool.call patent_law_*') : 'never called',
    })
  }

  // ── Security Controls (7) ── derived from DSL fields
  const snap = controls ?? computeControlsSnapshot(config, mounts)
  for (const ctrl of SECURITY_CONTROLS) {
    if (!snap.security[ctrl]) continue
    const n = countSecurityEvents(events, ctrl)
    pushDerived(
      `sec:${ctrl}`,
      `Sec · ${SECURITY_CONTROL_LABEL[ctrl]}`,
      'on',
      n > 0 ? 'fired' : 'idle',
      n > 0 ? plural(n, 'event') : 'no event',
    )
  }

  // ── Legal Controls (7) ── derived from DSL fields + mounts
  for (const ctrl of LEGAL_CONTROLS) {
    if (!snap.legal[ctrl]) continue
    const n = countLegalEvents(events, ctrl)
    const state = n > 0 ? 'fired' : ctrl === 'jurisdiction-filter' ? 'prompt' : 'idle'
    pushDerived(
      `leg:${ctrl}`,
      `Leg · ${LEGAL_CONTROL_LABEL[ctrl]}`,
      'on',
      state,
      n > 0 ? plural(n, 'event') : ctrl === 'jurisdiction-filter' ? 'system prompt only' : 'no event',
    )
  }

  return out
}

function countSecurityEvents(events: HarnessEvent[], ctrl: SecurityControl): number {
  switch (ctrl) {
    case 'input-isolation':
      return count(events, (e) => e.type === 'hook.decision' && e.hook === 'untrusted-input-wrap')
    case 'tool-boundary-gateway':
      return count(events, (e) =>
        e.type === 'permission.denied' ||
        (e.type === 'router.decision' && e.route !== 'EXECUTE'),
      )
    case 'least-privilege-creds':
      return count(events, (e) =>
        (e.type === 'router.decision' && e.matchedRule.startsWith('sandbox-')) ||
        (e.type === 'permission.denied' && e.gate === 'sandbox'),
      )
    case 'exec-sandbox':
      return count(events, (e) =>
        e.type === 'router.decision' && e.matchedRule.startsWith('sandbox-'),
      )
    case 'human-approval-gate':
      return count(events, (e) => e.type === 'hook.decision' && e.hook === 'approval-gate')
    case 'egress-dlp':
      return count(events, (e) => e.type === 'hook.decision' && e.hook === 'egress-dlp')
    case 'outofband-killswitch':
      return count(events, (e) =>
        e.type === 'hook.decision' && (e.hook === 'untrusted-input-wrap' || e.hook === 'egress-dlp'),
      )
  }
}

function countLegalEvents(events: HarnessEvent[], ctrl: LegalControl): number {
  switch (ctrl) {
    case 'authority-mcp':
      return count(events, (e) => e.type === 'tool.call' && e.tool.startsWith('patent_law'))
    case 'citation-audit':
      return count(events, (e) => e.type === 'verifier.verdict' || e.type === 'legal.assertion')
    case 'deadline-ledger':
      return count(events, (e) => e.type === 'hook.decision' && e.hook === 'deadline-ledger')
    case 'jurisdiction-filter':
      // prompt-only, no event
      return 0
    case 'issue-close-gate':
      return count(events, (e) => e.type === 'hook.decision' && e.hook === 'issue-close-gate')
    case 'risk-escalation-gate':
      return count(events, (e) => e.type === 'hook.decision' && e.hook === 'risk-escalation-gate')
    case 'hash-audit-chain':
      return count(events, (e) => e.type === 'model.request' && e.blocks.some((b) => b.preview != null))
  }
}

/**
 * Which harness module, if any, is responsible for a single event.
 *
 * The trajectory lists what happened; it does not say who did it. `tool.call fs_list`
 * is the file-backed switch, `router.decision … (deny-nonpublic-case-materials)` is the
 * permission gate, `hook.decision egress-dlp` is the global policy — without the
 * attribution they all read as one undifferentiated "harness did something", which is
 * exactly why an unwired switch was invisible for so long.
 *
 * Returns null for events the runner emits on its own account (tool routing, empty-answer
 * bookkeeping, posthoc failure tags). Those are not attributable to a knob, and claiming
 * otherwise would be worse than saying nothing.
 */
export function eventAttribution(
  e: HarnessEvent,
  config: HarnessConfig,
  mounts: PgMounts | undefined,
): ModuleActivity | null {
  return eventAttributions(e, config, mounts)[0] ?? null
}

/**
 * All harness modules responsible for a single event.
 *
 * Most events have exactly one owner, so this returns a single-element array
 * and `eventAttribution` (first element) keeps working. The one exception is
 * `model.request`: the system block in it is where prompt-only modules
 * (⑫ Feedforward Guidelines / ⑭ Self-Verification) inject their wording, while
 * the preview on it is ⑯ Observability's doing. Crediting the request to
 * observability alone is what left ⑫ unmarked on the trajectory — "where the
 * prompt is injected is where it must be labelled".
 *
 * Now also includes derived security/legal controls (sec:* / leg:*).
 */
export function eventAttributions(
  e: HarnessEvent,
  config: HarnessConfig,
  mounts: PgMounts | undefined,
  controls?: ControlsSnapshot,
): ModuleActivity[] {
  const snap = controls ?? computeControlsSnapshot(config, mounts)
  const mod = (field: ConfigField, state: ModuleState = 'fired'): ModuleActivity => ({
    key: field,
    label: COMPONENT_META[field].label,
    value: String(config[field]),
    state,
    evidence: '',
  })
  const pushSec = (ctrl: SecurityControl, state: ModuleState = 'fired'): ModuleActivity => ({
    key: `sec:${ctrl}`,
    label: `Sec · ${SECURITY_CONTROL_LABEL[ctrl]}`,
    value: 'on',
    state,
    evidence: '',
  })
  const pushLeg = (ctrl: LegalControl, state: ModuleState = 'fired'): ModuleActivity => ({
    key: `leg:${ctrl}`,
    label: `Leg · ${LEGAL_CONTROL_LABEL[ctrl]}`,
    value: 'on',
    state,
    evidence: '',
  })
  const mount = (): ModuleActivity => ({
    key: 'mount:patentLawMcp',
    label: 'Mount · patent-law-mcp',
    value: 'mounted',
    state: 'fired',
    evidence: '',
  })

  const out: ModuleActivity[] = []

  switch (e.type) {
    case 'tool.call':
    case 'tool.result':
      if (e.tool.startsWith('patent_law')) {
        if (mounts?.patentLawMcp) out.push(mount())
        if (snap.legal['authority-mcp']) out.push(pushLeg('authority-mcp'))
        return out
      }
      if (e.tool.startsWith('fs_')) {
        if (config.filesystem === 'file-backed-state') out.push(mod('filesystem'))
        if (config.sandbox !== 'off') out.push(mod('sandbox'))
        if (snap.security['least-privilege-creds']) out.push(pushSec('least-privilege-creds'))
        if (config.sandbox === 'write-barrier' && snap.security['exec-sandbox']) out.push(pushSec('exec-sandbox'))
        return out
      }
      return out

    case 'router.decision':
      if (e.matchedRule === 'deny-nonpublic-case-materials') {
        out.push(mod('permissions'))
        if (snap.security['tool-boundary-gateway']) out.push(pushSec('tool-boundary-gateway'))
        return out
      }
      if (e.matchedRule.startsWith('sandbox-')) {
        out.push(mod('sandbox'))
        if (snap.security['least-privilege-creds']) out.push(pushSec('least-privilege-creds'))
        if (config.sandbox === 'write-barrier' && snap.security['exec-sandbox']) out.push(pushSec('exec-sandbox'))
        return out
      }
      if (e.route !== 'EXECUTE' && snap.security['tool-boundary-gateway']) {
        out.push(pushSec('tool-boundary-gateway'))
        return out
      }
      return out

    case 'permission.denied':
      if (e.gate === 'permission-gate') {
        out.push(mod('permissions'))
        if (snap.security['tool-boundary-gateway']) out.push(pushSec('tool-boundary-gateway'))
        return out
      }
      if (e.gate === 'sandbox') {
        out.push(mod('sandbox'))
        if (snap.security['least-privilege-creds']) out.push(pushSec('least-privilege-creds'))
        if (config.sandbox === 'write-barrier' && snap.security['exec-sandbox']) out.push(pushSec('exec-sandbox'))
        return out
      }
      return out

    case 'hook.decision':
      if (e.hook === 'untrusted-input-wrap') {
        out.push(mod('hooks'))
        if (snap.security['input-isolation']) out.push(pushSec('input-isolation'))
        if (snap.security['outofband-killswitch']) out.push(pushSec('outofband-killswitch'))
        return out
      }
      if (e.hook === 'egress-dlp') {
        out.push(mod('globalPolicy'))
        if (snap.security['egress-dlp']) out.push(pushSec('egress-dlp'))
        if (snap.security['outofband-killswitch']) out.push(pushSec('outofband-killswitch'))
        return out
      }
      if (e.hook === 'approval-gate' && snap.security['human-approval-gate']) {
        out.push(pushSec('human-approval-gate'))
        return out
      }
      if (e.hook === 'deadline-ledger' && snap.legal['deadline-ledger']) {
        out.push(pushLeg('deadline-ledger'))
        return out
      }
      if (e.hook === 'issue-close-gate' && snap.legal['issue-close-gate']) {
        out.push(pushLeg('issue-close-gate'))
        return out
      }
      if (e.hook === 'risk-escalation-gate' && snap.legal['risk-escalation-gate']) {
        out.push(pushLeg('risk-escalation-gate'))
        return out
      }
      return out

    case 'verifier.verdict':
    case 'legal.assertion':
      out.push(mod('sensors'))
      if (snap.legal['citation-audit']) out.push(pushLeg('citation-audit'))
      return out

    case 'shaper.fire':
      out.push(mod('compression'))
      return out

    case 'model.request': {
      // Prompt-only modules have no event of their own; their injection site is
      // the system block. Mark it there, on every request that carries one —
      // regardless of whether trace is on (trace only controls the preview).
      if (config.guides !== BASE_CONFIG.guides && e.blocks.some((b) => b.layer === 'system'))
        out.push(mod('guides', 'prompt'))
      if (config.selfVerify !== BASE_CONFIG.selfVerify && e.blocks.some((b) => b.layer === 'system'))
        out.push(mod('selfVerify', 'prompt'))
      // Global Safety Policy also injects into system prompt (policy-enforced)
      if (config.globalPolicy !== BASE_CONFIG.globalPolicy && e.blocks.some((b) => b.layer === 'system'))
        out.push(mod('globalPolicy', 'prompt'))
      // Trace is what makes the request auditable; without it the blocks carry no content.
      if (config.observability !== 'off' && e.blocks.some((b) => b.preview != null)) {
        out.push(mod('observability'))
        if (snap.legal['hash-audit-chain']) out.push(pushLeg('hash-audit-chain'))
      }
      // Jurisdiction filter is prompt-only (guides=domain-checklist)
      if (snap.legal['jurisdiction-filter'] && e.blocks.some((b) => b.layer === 'system'))
        out.push(pushLeg('jurisdiction-filter', 'prompt'))
      return out
    }

    default:
      return out
  }
}
