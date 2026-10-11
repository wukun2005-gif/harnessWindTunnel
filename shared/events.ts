import { z } from 'zod'
import type { MastTag } from './mast'
import { LEGAL_ASSERTIONS, type LegalAssertion } from './legal'

// model-visible means logged: everything reaching the model must be fully reconstructible from the append-only event stream.
export const CONTEXT_LAYERS = ['system', 'memory', 'skillsMeta', 'toolSchema', 'history', 'toolResult'] as const
export type ContextLayer = (typeof CONTEXT_LAYERS)[number]

export const LAYER_LABEL: Record<ContextLayer, string> = {
  system: 'System',
  memory: 'Memory',
  skillsMeta: 'Skills Metadata',
  toolSchema: 'Tool Schema',
  history: 'History',
  toolResult: 'Tool Result',
}

export const contextBlock = z.object({
  layer: z.enum(CONTEXT_LAYERS),
  sourceComponent: z.string(),
  tokens: z.number().int().nonnegative(),
  positionIndex: z.number().int().nonnegative(),
  preview: z.string().optional(),
})
export type ContextBlock = z.infer<typeof contextBlock>

const SHAPERS = ['budget', 'snip', 'microcompact', 'contextCollapse', 'autoCompact'] as const
export type Shaper = (typeof SHAPERS)[number]
export const SHAPER_LABEL: Record<Shaper, string> = {
  budget: '① Budget',
  snip: '② Snip',
  microcompact: '③ Microcompact',
  contextCollapse: '④ Context Collapse',
  autoCompact: '⑤ Auto-compact',
}

// 'imported' (M2): external trajectory recorder — never rendered as a harness
// intervention (design §14.5 provenance rules).
export const AUTHOR = ['harness', 'narrator', 'imported'] as const
export type Author = (typeof AUTHOR)[number]

const base = { id: z.string(), ts: z.number(), runId: z.string(), scenarioId: z.string(), author: z.enum(AUTHOR) }

export const event = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('run.started'), model: z.string(), task: z.string() }),
  z.object({ ...base, type: z.literal('model.request'), step: z.number(), blocks: z.array(contextBlock), estTokens: z.number() }),
  z.object({ ...base, type: z.literal('model.response'), step: z.number(), thought: z.string(), stopReason: z.string() }),
  z.object({ ...base, type: z.literal('tool.call'), step: z.number(), tool: z.string(), argsSummary: z.string() }),
  z.object({ ...base, type: z.literal('tool.result'), step: z.number(), tool: z.string(), tokens: z.number(), summary: z.string() }),
  z.object({ ...base, type: z.literal('shaper.fire'), step: z.number(), order: z.number().int().min(1).max(5), shaper: z.enum(SHAPERS), freedTokens: z.number(), note: z.string() }),
  z.object({ ...base, type: z.literal('hook.decision'), step: z.number(), hook: z.string(), verdict: z.enum(['allow', 'deny', 'rewrite']), reason: z.string() }),
  z.object({ ...base, type: z.literal('permission.request'), step: z.number(), scope: z.string(), riskLevel: z.enum(['low', 'medium', 'high']) }),
  z.object({ ...base, type: z.literal('permission.granted'), step: z.number(), scope: z.string(), via: z.string() }),
  // M2: symmetric to permission.granted. Never impersonate this with
  // hook.decision{deny} — the permission gate and hooks are different gates.
  z.object({ ...base, type: z.literal('permission.denied'), step: z.number(), scope: z.string(), riskLevel: z.enum(['low', 'medium', 'high']).optional(), gate: z.string(), reason: z.string() }),
  // M2: runtime truth of the tri-state permission router
  // (EXECUTE/ASK/REFUSE; shared/redteam.ts PERMISSION_ROUTER). The static
  // buildPolicy() export is not a runtime record; only this event is.
  z.object({ ...base, type: z.literal('router.decision'), step: z.number(), tool: z.string(), route: z.enum(['EXECUTE', 'ASK', 'REFUSE']), matchedRule: z.string(), policyVersion: z.string() }),
  z.object({ ...base, type: z.literal('verifier.verdict'), step: z.number(), verifier: z.string(), verdict: z.enum(['pass', 'reject']), failureTag: z.custom<MastTag>().optional(), reason: z.string() }),
  // M2: one row per statute claim. verifier.verdict only carries failureTag +
  // reason and cannot hold the 5-class L-MARS assertion label. The label is a
  // real enum (not z.custom) so a missing or misspelled label is rejected at
  // write time instead of silently landing in the fact table.
  z.object({ ...base, type: z.literal('legal.assertion'), step: z.number(), claimText: z.string(), citedAuthority: z.string(), label: z.enum(LEGAL_ASSERTIONS), evidenceEventId: z.string().optional() }),
  z.object({ ...base, type: z.literal('sensor.lint'), step: z.number(), lint: z.string(), verdict: z.enum(['pass', 'reject']), reason: z.string() }),
  z.object({ ...base, type: z.literal('agent.fork'), step: z.number(), childId: z.string(), purpose: z.string() }),
  z.object({ ...base, type: z.literal('agent.join'), step: z.number(), childId: z.string(), summary: z.string() }),
  z.object({ ...base, type: z.literal('optimizer.fire'), step: z.number(), component: z.string(), action: z.string(), detail: z.string() }),
  z.object({ ...base, type: z.literal('compact.boundary'), step: z.number(), strategy: z.string(), beforeTokens: z.number(), afterTokens: z.number() }),
  z.object({ ...base, type: z.literal('failure.tag'), step: z.number(), mast: z.custom<MastTag>(), confidence: z.number(), note: z.string() }),
  z.object({
    ...base,
    type: z.literal('harness.mutation'),
    commitId: z.string(),
    parentIds: z.array(z.string()),
    configDiff: z.record(z.tuple([z.string(), z.string()])),
    predictedGain: z.tuple([z.number(), z.number()]),
    falsification: z.object({ rescued: z.number().int().nonnegative(), regressed: z.number().int().nonnegative() }),
    approvedBy: z.enum(['human', 'gate']),
  }),
  z.object({ ...base, type: z.literal('run.finished'), success: z.boolean(), tokens: z.number(), latencyP50: z.number(), failureModes: z.record(z.number()) }),
])
export type HarnessEvent = z.infer<typeof event>

export type SourceKind = 'fixture' | 'paper-reproduction' | 'live' | 'imported'
export interface SourceRef {
  kind: SourceKind
  label: string
  citation?: string
}

export interface MetricsEntry {
  successRate: number
  tokens: number
  latencyP50: number
  failureModes: Partial<Record<MastTag, number>>
  source: SourceRef
  /**
   * Per-run scorecard success rates (%) backing F2-6 lower-tail stats.
   * Fixture readings for demo; absent = single point estimate only.
   */
  runs?: number[]
}

export interface BranchMeta {
  branchId: string
  fingerprint: string
  config: import('./config').HarnessConfig
  file: string
  note?: string
}

export interface ScenarioMeta {
  scenarioId: string
  family: string
  familyLabel: string
  task: string
  model: string
  traps: string[]
  diffPairs: [string, string][]
  branches: BranchMeta[]
  metrics: Record<string, MetricsEntry>
}

export interface ReplayMeta {
  runId: string
  scenarioId: string
  branchId: string
  configFingerprint: string
  exactMatch: boolean
  nearestTo?: { branchId: string; distance: number }
  source: SourceRef
}
