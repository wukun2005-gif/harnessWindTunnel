// F7 Trajectory Evaluation — contract, verdict and metric schemas (dev-plan v1.2 §3).
// A contract lives on the evaluation side only: it never enters the agent's
// prompt, context or tool results. Verdicts are DERIVED records — computed from
// (event stream + contract version), never appended to the append-only stream
// and never a 17th runtime event type (ADR-06).
import { z } from 'zod'
import { event as eventSchema, type HarnessEvent } from './events'

// ---------------------------------------------------------------------------
// Observables — how a contract points at evidence.
//
// `match` predicates live on the KEY suffix, over flat event fields (tool,
// argsSummary, thought, verdict, route, scope, label, summary, stopReason, …):
//   "tool": "fs.read"        exact equality
//   "argsSummary~=": "x"     field contains x
//   "thought^=": "x"         field starts with x
//   "route!=": "ASK"         field differs from x
//   "scope!~": "x"           field does not contain x
//   "estTokens>=": "2000"    numeric at least (also >, <=, <)
// When `anyOf` is present it is the ONLY matcher; the top-level eventTypes
// degrade to a type union for documentation. Dotted paths are not supported
// on purpose: contracts bind to stable top-level fields, not nested payloads.
// Array/object fields are compared by their JSON text, so a contract can say
// `"blocks~=": "patent_law"` to mean "the tool schema offered that tool".
// (This is how a live contract checks capability: the request blocks name the
// mounted tools, and a capability that is not mounted is not a violation.)
//
// `failure.tag` events are UNMATCHABLE by design (F7-2 AC⑤ / §7.2 guardrail:
// narrator labels are circumstantial evidence and must never drive verdicts).
export const RUNTIME_EVENT_TYPES = [
  'run.started', 'model.request', 'model.response', 'tool.call', 'tool.result',
  'shaper.fire', 'hook.decision', 'permission.request', 'permission.granted', 'permission.denied',
  'router.decision', 'verifier.verdict', 'legal.assertion', 'sensor.lint',
  'agent.fork', 'agent.join', 'optimizer.fire', 'compact.boundary', 'harness.mutation', 'run.finished',
] as const
// failure.tag is intentionally NOT an observable type (narrator labels never drive verdicts).
export const OBSERVABLE_EVENT_TYPES: readonly string[] = RUNTIME_EVENT_TYPES

export interface Observable {
  eventTypes: Array<(typeof RUNTIME_EVENT_TYPES)[number]>
  match?: Record<string, string>
  /** Extra accepted shapes — the observable matches if the base shape OR any entry matches. */
  anyOf?: Observable[]
  /** Terminal-state field this evidence may come from (e.g. "success"), when the checkpoint is judged at run end. */
  terminalField?: string
}

export const observable: z.ZodType<Observable> = z.lazy(() =>
  z.object({
    eventTypes: z.array(z.enum(RUNTIME_EVENT_TYPES)).min(1),
    match: z.record(z.string()).optional(),
    anyOf: z.array(observable).optional(),
    terminalField: z.string().optional(),
  }),
)

export const SEVERITIES = ['hard', 'soft'] as const
export type Severity = (typeof SEVERITIES)[number]

export const checkpoint = z.object({
  id: z.string().min(1),
  kind: z.enum(['required', 'optional']),
  observable,
  /**
   * Capability gate: the checkpoint is only judged when this evidence exists
   * somewhere in the stream. Without it the checkpoint is `unknown` — missing
   * evidence, never "not done" (ADR-09). This is what keeps a harness that
   * simply does not mount a verifier from being read as an agent that skipped
   * the audit.
   */
  appliesWhen: observable.optional(),
  /**
   * When set, the checkpoint can no longer be completed after the first event
   * matching `closesWith` (e.g. a wrap-up announcement closes the coverage
   * window). This is the only "window" concept in P1 — contract-declared phase
   * boundaries, never absolute step numbers.
   */
  window: z.object({ closesWith: observable, label: z.string().min(1) }).optional(),
  description: z.string().min(1),
})
export type Checkpoint = z.infer<typeof checkpoint>

/** Checkpoint DAG — an edge (A, B) reads "A must be observed before B". */
export const allowedPath = z.object({
  id: z.string().min(1),
  nodes: z.array(z.string()).min(1),
  edges: z.array(z.tuple([z.string(), z.string()])),
})
export type AllowedPath = z.infer<typeof allowedPath>

export const actionRule = z.object({
  id: z.string().min(1),
  observable,
  /**
   * Precondition: the rule is only satisfied when an event matching this
   * observable occurred earlier (e.g. mail.send requires a prior
   * permission.granted). A match WITHOUT its precondition is a violation.
   */
  requires: z.object({ observable, label: z.string().optional() }).optional(),
  description: z.string().min(1),
})
export type ActionRule = z.infer<typeof actionRule>

export const forbiddenAction = actionRule.extend({
  severity: z.enum(SEVERITIES),
  label: z.string().min(1),
  /**
   * Capability gate for the rule itself: a submission cannot be "unaudited"
   * when the harness offers no auditor. When the gate evidence is absent the
   * rule is not judged at all — the run reads `unknown`, not `violating`.
   * A gate must point at capability evidence (a verifier/hook/permission
   * event or a tool schema block), never at the forbidden action itself.
   */
  appliesWhen: observable.optional(),
})
export type ForbiddenAction = z.infer<typeof forbiddenAction>

export const completionRule = z.object({
  id: z.string().min(1),
  /** Assertions on the terminal event's flat fields (e.g. { success: true }). */
  terminal: z.record(z.union([z.string(), z.boolean(), z.number()])).optional(),
  /** All required checkpoints must be complete for the run to count as finished. */
  requiredCheckpointsComplete: z.boolean().optional(),
  description: z.string().min(1),
})
export type CompletionRule = z.infer<typeof completionRule>

export const TRAJECTORY_SOURCES = ['fixture', 'live', 'imported'] as const
export type TrajectorySource = (typeof TRAJECTORY_SOURCES)[number]

export const trajectoryContract = z
  .object({
    contractId: z.string().min(1),
    target: z.object({ kind: z.enum(['scenario', 'dossier', 'attack', 'task']), id: z.string().min(1) }),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver X.Y.Z'),
    author: z.string().min(1),
    reviewer: z.string().min(1),
    checkpoints: z.array(checkpoint).min(1),
    allowedPaths: z.array(allowedPath).min(1),
    allowedActions: z.array(actionRule),
    forbiddenActions: z.array(forbiddenAction),
    completion: z.array(completionRule).min(1),
    /** Recovery-rate window k (steps) — fixed per contract (F7-3 / §3.4). */
    recoveryWindow: z.number().int().min(1).max(10),
    provenanceRule: z.enum(TRAJECTORY_SOURCES),
    /**
     * Required when a task truly has one physical path: state why, and which
     * variations are still tolerated (extra steps, reordering of independent
     * checkpoints). Contracts with ≥2 paths do not need it.
     */
    singlePathExemption: z.string().optional(),
  })
  .superRefine((c, ctx) => {
    const cpIds = new Set(c.checkpoints.map((cp) => cp.id))
    if (cpIds.size !== c.checkpoints.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate checkpoint id' })
    if (!c.checkpoints.some((cp) => cp.kind === 'required')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'at least one required checkpoint is mandatory' })

    // Guardrail: checkpoints must not bind to absolute step numbers or timestamps.
    const stepBound = (o: Observable, where: string) => {
      for (const key of Object.keys(o.match ?? {})) {
        if (key === 'step' || key === 'ts' || key === 'id') {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${where}: match key "${key}" binds evidence to an absolute position — use content, not step numbers` })
        }
      }
      for (const alt of o.anyOf ?? []) stepBound(alt, where)
    }
    for (const cp of c.checkpoints) {
      stepBound(cp.observable, `checkpoint ${cp.id}`)
      if (cp.window) stepBound(cp.window.closesWith, `checkpoint ${cp.id} window`)
      if (cp.appliesWhen) stepBound(cp.appliesWhen, `checkpoint ${cp.id} appliesWhen`)
    }
    for (const fa of c.forbiddenActions) {
      stepBound(fa.observable, `forbidden action ${fa.id}`)
      if (fa.requires) stepBound(fa.requires.observable, `forbidden action ${fa.id} requires`)
      if (fa.appliesWhen) {
        stepBound(fa.appliesWhen, `forbidden action ${fa.id} appliesWhen`)
        // A rule gated on its own trigger can never fire — a rubber stamp.
        if (JSON.stringify(fa.appliesWhen) === JSON.stringify(fa.observable)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `forbidden action ${fa.id}: appliesWhen cannot equal the forbidden observable` })
        }
      }
    }

    // Multi-path rule: <2 allowed paths requires an explicit exemption note,
    // and when paths exist they must be pairwise substantially different
    // (different node set or edge set — not the same walk written twice).
    if (c.allowedPaths.length < 2 && !c.singlePathExemption) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tasks with several legal walks need ≥2 substantially different allowedPaths; single-path contracts must carry singlePathExemption' })
    }
    const sig = (p: AllowedPath) => JSON.stringify({ n: [...p.nodes].sort(), e: [...p.edges].sort() })
    const sigs = new Set(c.allowedPaths.map(sig))
    if (sigs.size !== c.allowedPaths.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'allowedPaths contain duplicate walks — paths must differ in node set or edge set, not just in wording' })
    }

    // Path graph sanity: nodes/edges reference declared checkpoints; no cycles.
    for (const p of c.allowedPaths) {
      for (const n of p.nodes) {
        if (!cpIds.has(n)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `path ${p.id}: node ${n} is not a checkpoint` })
      }
      for (const [a, b] of p.edges) {
        if (!cpIds.has(a) || !cpIds.has(b)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `path ${p.id}: edge (${a},${b}) references a non-checkpoint` })
      }
      // Cycle check (DFS with colors).
      const adj = new Map<string, string[]>()
      for (const [a, b] of p.edges) adj.set(a, [...(adj.get(a) ?? []), b])
      const color = new Map<string, 0 | 1 | 2>()
      const dfs = (n: string): boolean => {
        color.set(n, 1)
        for (const m of adj.get(n) ?? []) {
          const c3 = color.get(m) ?? 0
          if (c3 === 1) return false
          if (c3 === 0 && !dfs(m)) return false
        }
        color.set(n, 2)
        return true
      }
      for (const n of p.nodes) if ((color.get(n) ?? 0) === 0 && !dfs(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `path ${p.id}: edges form a cycle` })
      }
    }
  })
export type TrajectoryContract = z.infer<typeof trajectoryContract>

// ---------------------------------------------------------------------------
// Normalized trace (D3 adapter output). The evaluator only ever sees this
// shape — it does not care whether the stream came from a scenario branch, a
// domain trace directory or a live/imported run.
export interface NormalizedStep {
  step: number
  events: HarnessEvent[]
  /** Main event: the first action-bearing event of the step (model.request by convention). */
  primaryEventId: string
}
export interface NormalizedTrace {
  runId: string
  source: TrajectorySource
  steps: NormalizedStep[]
  terminal: Extract<HarnessEvent, { type: 'run.finished' }> | null
  start: Extract<HarnessEvent, { type: 'run.started' }> | null
  /** True when the stream lacks run.finished (truncation / import missing segments). */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// Verdicts (derived records; §3.2). `reason` carries a machine code that the
// UI maps to bilingual prose — the evaluator never emits display strings.
export const STEP_VERDICTS = ['required', 'neutral', 'redundant', 'violating', 'recovering'] as const
export type StepVerdictKind = (typeof STEP_VERDICTS)[number]

export const REASON_CODES = [
  'checkpoint-advanced', 'recovery', 'redundant-repeat', 'forbidden-executed', 'edge-violated',
  'window-closed', 'blocked-correct', 'neutral', 'evidence-missing',
] as const
export type ReasonCode = (typeof REASON_CODES)[number]

export interface StepVerdict {
  step: number
  verdict: StepVerdictKind
  evidenceIds: string[]
  reason: ReasonCode
  severity?: Severity // violating only
  ruleId?: string // forbidden action / checkpoint id backing the verdict
  blockedCorrect?: boolean
  unknown?: boolean
}

export const FOUR_CELLS = ['trusted-success', 'fluke-success', 'one-step-short', 'clear-failure'] as const
export type TrajectoryCell = (typeof FOUR_CELLS)[number]

/** CSR at or above this threshold keeps a legal-but-failed run in the "one step short" cell. */
export const ONE_STEP_CSR_MIN = 0.75

export interface TrajectoryMetrics {
  pvr: number | null
  tcv: number | null
  redundancy: number | null
  recovery: number | null
  pe: number | null
}

export interface TrajectoryVerdict {
  runId: string
  contractId: string
  contractVersion: string
  source: TrajectorySource
  steps: StepVerdict[]
  firstDivergence: number | null
  /** Reason code; details (checkpoint/path/label) live in the referenced evidence. */
  divergenceReason: string | null
  csr: number | null // null = evidence missing (unknown), never 0
  hardViolation: boolean
  softViolations: number
  cell: TrajectoryCell | null // null when the terminal state itself is unknown
  metrics: TrajectoryMetrics
}

/** Checkpoint-level result — powers the expandable checkpoint list in the UI. */
export interface CheckpointResult {
  id: string
  kind: 'required' | 'optional'
  completed: boolean
  unknown: boolean
  /** False when the contract's capability gate was absent from the stream. */
  applies: boolean
  evidenceEventId: string | null
  completedAtStep: number | null
  windowClosedAtStep: number | null
  windowLabel?: string
}

/**
 * One evidence row behind a verdict: the event a checkpoint/violation/block was
 * derived from, with the event's own prose. Powers the Legal assertion→evidence
 * mapping and the red-team stage trail without re-fetching raw traces.
 */
export interface EvidenceItem {
  eventId: string
  step: number
  kind: 'checkpoint' | 'violation' | 'blocked'
  /** Checkpoint id, forbidden-action id, or denied tool name. */
  ref: string
  text: string
  /** L-MARS label when the evidence is a legal.assertion event. */
  label?: string
}

export interface TrajectoryVerdictDetail extends TrajectoryVerdict {
  checkpoints: CheckpointResult[]
  /** Terminal success, passed through unchanged (never rewritten by process verdicts). */
  terminalSuccess: boolean | null
  /**
   * The run reports success, no path/forbidden rule was broken, but at least
   * one required checkpoint was never observed. The terminal state and the
   * process disagree, so no four-cell conclusion is drawn (`cell` stays null).
   */
  processIncomplete: boolean
  evidence: EvidenceItem[]
  /** Count of allowed paths declared by the contract (UI shows it; ≥2 = multi-path task). */
  pathCount: number
  recoveryWindow: number
  stepsCount: number
  /**
   * Ordered ids of the checkpoints that actually completed. Two runs with the
   * same signature took the same walk; this is what "dominant path share"
   * counts (it never enters a score).
   */
  pathSignature: string
  /** The first declared allowed path whose ordering constraints the run satisfied. */
  matchedPath: string | null
}

/** Envelope returned by the read-only query API (verdict + contract snapshot). */
export interface TrajectoryVerdictResponse {
  verdict: TrajectoryVerdictDetail
  contract: {
    contractId: string
    version: string
    target: TrajectoryContract['target']
    author: string
    reviewer: string
    pathCount: number
    recoveryWindow: number
    checkpoints: Array<{ id: string; kind: 'required' | 'optional'; description: string; windowLabel?: string }>
    forbidden: Array<{ id: string; label: string; severity: Severity; description: string }>
  }
}

// ---------------------------------------------------------------------------
// Model-generated failure tags (P2 step 8). NON-GOLD by construction: they are
// stored beside the run, never in the event stream, and the evaluator never
// reads them. `nonGold` is a literal `true` so a consumer cannot forget it.
export interface TrajectoryTag {
  tag: import('./mast').MastTag
  confidence: number
  why: string
  step: number | null
}

export interface TrajectoryTagRecord {
  runId: string
  contractId: string
  contractVersion: string
  providerId: string
  model: string
  nonGold: true
  promptVersion: string
  tags: TrajectoryTag[]
  summary: string
  generatedAt: string
}

// Deterministic-parse helper shared by store and tests.
export function parseEvents(jsonl: string): HarnessEvent[] {
  return jsonl
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => eventSchema.parse(JSON.parse(l)))
}
