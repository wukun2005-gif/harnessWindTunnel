// M4 deterministic edit-surface routing (PRISM §7.3) + dynamic upgrade.
//
// This module is the closed set the LLM is allowed to work inside. It never
// calls an LLM: given a failure tag and the history of applied surfaces it
// deterministically decides the edit surface (prompt / middleware / joint),
// the single seam to change, and the legal DSL/mount values that turn it on.
// 'other' and any out-of-table combination always require human review.
import type { HarnessConfig } from '../../shared/config'
import type { MastTag } from '../../shared/mast'
import type { EvoSurface, PgMounts } from '../../shared/playground'

/** Security/legal hard-gate seams that any autonomy level keeps human-approved. */
export const HARD_GATE_SEAMS = new Set([
  'permissions',
  'globalPolicy',
  'sandbox',
  'authority-mcp',
  'citation-audit',
])

export interface RouteRule {
  tag: MastTag
  /** Initial surface from the §7.3 table. 'human' means no auto-routing. */
  initial: EvoSurface | 'human'
  /** Human-readable seam name (shown on the card). */
  seam: string
  /** Control key this seam toggles (for the harness-modules UI labels). */
  seamControl: string
  /** Deterministic middleware form (legal DSL values only). */
  dsl?: Partial<HarnessConfig>
  /** Deterministic mount form (authority-mcp lives in PgMounts, not the DSL). */
  mount?: Partial<PgMounts>
  /** Whether the deterministic part survives prompt→joint→middleware upgrades. */
  hardGate: boolean
  /** Prompt-surface guide pack to select. */
  guideStyle?: 'style-rules' | 'domain-checklist'
  /** Deterministic control added when a prompt tag upgrades to joint. */
  jointDsl?: Partial<HarnessConfig>
}

/**
 * §7.3 routing table — one closed entry per first-class failure tag.
 * Single-variable rule: each entry targets exactly one seam (the DSL/mount
 * patch may carry a mount + the one control that implements that seam).
 */
export const ROUTE_TABLE: Record<MastTag, RouteRule | undefined> = {
  'premature-victory': {
    tag: 'premature-victory', initial: 'middleware',
    seam: 'selfVerify self-check before declaring done (cover every sub-question)', seamControl: 'issue-close-gate',
    dsl: { selfVerify: 'premature-victory-check' }, hardGate: false,
  },
  'fabricated-citation': {
    tag: 'fabricated-citation', initial: 'middleware',
    seam: 'authority-mcp retrieve-before-generate + citation-audit verification', seamControl: 'authority-mcp',
    dsl: { sensors: 'verifier' }, mount: { patentLawMcp: true }, hardGate: true,
  },
  'scope-violation': {
    tag: 'scope-violation', initial: 'middleware',
    seam: 'permissions gate (deny-first deterministic backstop)', seamControl: 'tool-boundary-gateway',
    dsl: { permissions: 'deny-first' }, hardGate: true,
  },
  'unaware-of-stopping': {
    tag: 'unaware-of-stopping', initial: 'middleware',
    seam: 'selfVerify stop-condition self-check', seamControl: 'issue-close-gate',
    dsl: { selfVerify: 'premature-victory-check' }, hardGate: false,
  },
  'step-repetition': {
    tag: 'step-repetition', initial: 'middleware',
    seam: 'loopControl loop detection with reflexion', seamControl: 'loopControl',
    dsl: { loopControl: 'reflexion' }, hardGate: false,
  },
  'context-loss': {
    tag: 'context-loss', initial: 'middleware',
    seam: 'memory layered store against context loss', seamControl: 'memory',
    dsl: { memory: 'layered' }, hardGate: false,
  },
  'long-horizon-decay': {
    tag: 'long-horizon-decay', initial: 'middleware',
    seam: 'compression five-layer compaction checkpoints', seamControl: 'compression',
    dsl: { compression: 'five-layer' }, hardGate: false,
  },
  'fail-to-clarify': {
    tag: 'fail-to-clarify', initial: 'prompt',
    seam: 'guides clarification instruction (ask before answering)', seamControl: 'guides',
    guideStyle: 'style-rules', jointDsl: { planner: 'todo-list' }, hardGate: false,
  },
  'spec-misinterpretation': {
    tag: 'spec-misinterpretation', initial: 'prompt',
    seam: 'guides=domain-checklist (task-spec checklist)', seamControl: 'guides',
    guideStyle: 'domain-checklist', jointDsl: { selfVerify: 'premature-victory-check' }, hardGate: false,
  },
  'task-derailment': {
    tag: 'task-derailment', initial: 'prompt',
    seam: 'planner / guides against task derailment', seamControl: 'planner',
    guideStyle: 'domain-checklist', jointDsl: { planner: 'todo-list' }, hardGate: false,
  },
  'weak-grounding': {
    tag: 'weak-grounding', initial: 'joint',
    seam: 'guides citation requirement + sensors=verifier check', seamControl: 'citation-audit',
    dsl: { sensors: 'verifier' }, guideStyle: 'domain-checklist', hardGate: true,
  },
  'reasoning-action-mismatch': {
    tag: 'reasoning-action-mismatch', initial: 'joint',
    seam: 'guides + planner/selfVerify alignment before acting', seamControl: 'selfVerify',
    dsl: { selfVerify: 'premature-victory-check' }, guideStyle: 'style-rules', hardGate: false,
  },
  other: undefined, // forced human review — no auto routing
}

export interface HumanDecision {
  surface: 'human'
  reason: string
}

export interface RoutingDecision {
  surface: EvoSurface
  seam: string
  seamControl: string
  dsl: Partial<HarnessConfig>
  mount: Partial<PgMounts>
  guideStyle?: 'style-rules' | 'domain-checklist'
  hardGate: boolean
  reason: string
  upgraded: boolean
}

const SURFACE_ORDER: EvoSurface[] = ['prompt', 'joint', 'middleware']

/**
 * Decide the edit surface for a cluster, applying the dynamic upgrade rule:
 * a prompt fix that was applied and still fails next generation upgrades to
 * joint, then middleware. Never downgrades.
 */
export function routeCluster(
  tag: MastTag,
  appliedSurfaces: Array<{ surface: string }>,
): RoutingDecision | HumanDecision {
  const rule = ROUTE_TABLE[tag]
  if (!rule) {
    return {
      surface: 'human',
      reason: `Failure tag "${tag}" is outside the closed routing table: forced human review, no auto routing.`,
    }
  }

  let surface: EvoSurface = rule.initial === 'human' ? 'middleware' : rule.initial
  let upgraded = false
  const reasonParts: string[] = []

  if (rule.initial === 'prompt' || rule.initial === 'joint') {
    const applied = new Set(appliedSurfaces.map((s) => s.surface))
    if (rule.initial === 'prompt') {
      if (applied.has('prompt') && applied.has('joint')) {
        surface = 'middleware'
        upgraded = true
        reasonParts.push('prompt and joint already applied and the next generation still failed → upgrade to middleware')
      } else if (applied.has('prompt')) {
        surface = 'joint'
        upgraded = true
        reasonParts.push('prompt already applied and the next generation still failed → upgrade to joint')
      }
    } else if (rule.initial === 'joint' && applied.has('joint')) {
      surface = 'middleware'
      upgraded = true
      reasonParts.push('joint already applied and the next generation still failed → upgrade to middleware')
    }
  }

  if (!upgraded) {
    reasonParts.push(`routing table default: ${tag} → ${rule.initial} surface (seam: ${rule.seam})`)
  }

  // Compose the deterministic + prompt parts for the chosen surface.
  const dsl: Partial<HarnessConfig> = {}
  const mount: Partial<PgMounts> = {}
  let guideStyle: RoutingDecision['guideStyle']

  if (surface === 'prompt') {
    if (rule.guideStyle) guideStyle = rule.guideStyle
  } else if (surface === 'joint') {
    // joint = prompt guidance + one deterministic control.
    if (rule.guideStyle) guideStyle = rule.guideStyle
    const jointDsl = rule.initial === 'joint' ? rule.dsl : rule.jointDsl
    if (jointDsl) Object.assign(dsl, jointDsl)
    if (rule.initial === 'joint' && rule.mount) Object.assign(mount, rule.mount)
  } else {
    // middleware = deterministic only.
    if (rule.dsl) Object.assign(dsl, rule.dsl)
    if (rule.jointDsl) Object.assign(dsl, rule.jointDsl)
    if (rule.mount) Object.assign(mount, rule.mount)
  }

  return {
    surface,
    seam: rule.seam,
    seamControl: rule.seamControl,
    dsl,
    mount,
    guideStyle,
    hardGate: rule.hardGate,
    reason: reasonParts.join('; '),
    upgraded,
  }
}

/** Has the seam's deterministic control already been turned on for this run? */
export function capabilityAlreadyOn(
  config: HarnessConfig,
  mounts: PgMounts,
  dsl: Partial<HarnessConfig>,
  mount: Partial<PgMounts>,
): boolean {
  for (const [k, v] of Object.entries(dsl)) {
    if (config[k as keyof HarnessConfig] !== v) return false
  }
  if (mount.patentLawMcp === true && mounts.patentLawMcp !== true) return false
  return true
}

export { SURFACE_ORDER }
