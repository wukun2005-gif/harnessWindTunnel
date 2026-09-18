/* eslint-disable no-console */
// Scenario DSL → fixture generator. Hand-writing JSONL is forbidden; all trajectories and metric matrices are produced here.
// A branch is a scenario function; branches share a trunk (the first N steps), and the wind-tunnel TrajDiff pairs branches via diffPairs.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'
import { cfg, fingerprint, type HarnessConfig } from '../shared/config'
import {
  CONTEXT_LAYERS, event as eventSchema, type ContextBlock, type ContextLayer,
  type HarnessEvent, type MetricsEntry, type ScenarioMeta, type SourceRef,
} from '../shared/events'
import type { MastTag } from '../shared/mast'
import { hashSeed, mulberry32 } from '../shared/reliability'

const ROOT = resolve(import.meta.dirname, '..')
const OUT = resolve(ROOT, 'data')

// ---------- Recorder ----------
let seq = 0

class Rec {
  evs: HarnessEvent[] = []
  t = 0
  step = 0
  constructor(private runId: string, private scenarioId: string) {}

  add(e: Record<string, unknown>) {
    this.t += 260
    this.evs.push({ author: 'harness', ...e, id: `${this.runId}-${String(++seq).padStart(4, '0')}`, ts: this.t, runId: this.runId, scenarioId: this.scenarioId } as HarnessEvent)
  }
  start(model: string, task: string) {
    this.add({ type: 'run.started', model, task })
  }
  req(blocks: ContextBlock[], thought: string, stopReason = 'end_turn') {
    this.step++
    const est = blocks.reduce((n, b) => n + b.tokens, 0)
    this.add({ type: 'model.request', step: this.step, blocks, estTokens: est })
    this.add({ type: 'model.response', step: this.step, thought, stopReason })
    return this.step
  }
  tool(tool: string, args: string, tokens: number, summary: string) {
    this.add({ type: 'tool.call', step: this.step, tool, argsSummary: args })
    this.add({ type: 'tool.result', step: this.step, tool, tokens, summary })
  }
  hook(hook: string, verdict: 'allow' | 'deny' | 'rewrite', reason: string) {
    this.add({ type: 'hook.decision', step: this.step, hook, verdict, reason })
  }
  perm(scope: string, riskLevel: 'low' | 'medium' | 'high') {
    this.add({ type: 'permission.request', step: this.step, scope, riskLevel })
  }
  granted(scope: string, via: string) {
    this.add({ type: 'permission.granted', step: this.step, scope, via })
  }
  verifier(verifier: string, verdict: 'pass' | 'reject', reason: string, failureTag?: MastTag) {
    this.add({ type: 'verifier.verdict', step: this.step, verifier, verdict, reason, ...(failureTag ? { failureTag } : {}) })
  }
  lint(lint: string, verdict: 'pass' | 'reject', reason: string) {
    this.add({ type: 'sensor.lint', step: this.step, lint, verdict, reason })
  }
  fork(childId: string, purpose: string) {
    this.add({ type: 'agent.fork', step: this.step, childId, purpose })
  }
  join(childId: string, summary: string) {
    this.add({ type: 'agent.join', step: this.step, childId, summary })
  }
  compact(strategy: string, before: number, after: number) {
    this.add({ type: 'compact.boundary', step: this.step, strategy, beforeTokens: before, afterTokens: after })
  }
  optimizer(component: string, action: string, detail: string) {
    this.add({ type: 'optimizer.fire', step: this.step, component, action, detail })
  }
  tag(mast: MastTag, confidence: number, note: string) {
    // Narrator annotation, NOT harness runtime behavior — see PRD §1.5 事件作者.
    this.add({ type: 'failure.tag', step: this.step, mast, confidence, note, author: 'narrator' })
  }
  finish(m: { success: boolean; tokens: number; latencyP50: number; failureModes: Partial<Record<MastTag, number>> }) {
    this.add({ type: 'run.finished', ...m })
  }
}

// ---------- Context-block helpers ----------
const blk = (layer: ContextLayer, sourceComponent: string, tokens: number, preview?: string): Omit<ContextBlock, 'positionIndex'> => ({ layer, sourceComponent, tokens, preview })

function ctx(o: {
  history: number
  toolResult?: { source: string; tokens: number; preview: string }
  sys?: number; memory?: number; skills?: number; toolSchema?: number
}): ContextBlock[] {
  const list = [
    blk('system', 'core.prompt', o.sys ?? 850, 'You are a knowledge-work agent…'),
    ...(o.memory ? [blk('memory', 'memory.layered', o.memory, 'User preferences: respond in English; company wording in glossary')] : []),
    ...(o.skills ? [blk('skillsMeta', 'skills.registry', o.skills, 'report-writing skill v3 (metadata)')] : []),
    blk('toolSchema', 'tool.registry', o.toolSchema ?? 520, 'web_search / fs.* / db.query / mail.send…'),
    blk('history', 'loop.history', o.history, '(summary of earlier turns)'),
    ...(o.toolResult ? [blk('toolResult', o.toolResult.source, o.toolResult.tokens, o.toolResult.preview)] : []),
  ]
  return list.map((b, i) => ({ ...b, positionIndex: i }))
}

const FIVE = ['budget', 'snip', 'microcompact', 'contextCollapse', 'autoCompact'] as const
function fireFive(rec: Rec, freed: [number, number, number, number, number], before: number) {
  const total = freed.reduce((a, b) => a + b, 0)
  rec.compact('five-layer', before, before - total)
  freed.forEach((n, i) => rec.add({ type: 'shaper.fire', step: rec.step, order: i + 1, shaper: FIVE[i], freedTokens: n, note: ['Single overflow → file reference', 'Trim older history', 'Cache-aware fine-grained compaction', 'Read-only collapse projection', 'Semantic summary fallback'][i] }))
}

// ---------- Branch & scenario definitions ----------
interface Branch {
  branchId: string
  config: HarnessConfig
  build?: (rec: Rec) => void
  metrics: MetricsEntry
}

const S = (kind: SourceRef['kind'], label: string, citation?: string): SourceRef => ({ kind, label, citation })

interface Scenario {
  scenarioId: string
  family: string
  familyLabel: string
  task: string
  model: string
  traps: string[]
  branches: Branch[]
  diffPairs: [string, string][]
}

const RUNS_N = 8
/**
 * Deterministic per-run fixture readings backing F2-6 lower-tail stats.
 * Mean tracks the headline rate (sd ≈ 2pp); same inputs → same runs, so every
 * downstream stat is recalculable with no extra model calls.
 */
function runsFor(rate: number, key: string, n = RUNS_N): number[] {
  const rand = mulberry32(hashSeed(key))
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const z = (rand() + rand() + rand() - 1.5) * 4
    out.push(Math.max(0, Math.min(100, Math.round((rate + z) * 10) / 10)))
  }
  return out
}

const fx = (successRate: number, tokens: number, latencyP50: number, failureModes: Partial<Record<MastTag, number>> = {}): MetricsEntry => ({ successRate, tokens, latencyP50, failureModes, runs: runsFor(successRate, `${successRate}|${tokens}|${latencyP50}|${Object.keys(failureModes).sort().join(',')}`), source: S('fixture', 'Illustrative data') })

const MODEL = 'gpt-5.4-xhigh (fixed model, illustrative)'

const scenarios: Scenario[] = [
  // ============ Writing ============
  {
    scenarioId: 'writing-q3-report', family: 'writing', familyLabel: 'Writing / Reports',
    task: 'Summarize 24 Q3 source documents and draft the Q3 Business Review report',
    model: MODEL, traps: ['Long-context overflow', 'Late-stage quality decay'],
    diffPairs: [['fivelayer', 'budget']],
    branches: [
      {
        branchId: 'nocomp', config: cfg(),
        metrics: { ...fx(22.0, 221_000, 248_000, { 'long-horizon-decay': 2 }), source: S('fixture', 'Illustrative data') },
        build(rec) {
          rec.start(MODEL, 'Summarize 24 Q3 source documents and draft the Q3 Business Review report')
          rec.req(ctx({ history: 1800 }), 'First list the source documents')
          rec.tool('fs.list', 'docs/q3/', 400, '24 files')
          rec.req(ctx({ history: 2600, toolResult: { source: 'fs.read(sales-wk-01..08)', tokens: 3800, preview: 'Weekly bundle…' } }), 'Batch-read the weeklies')
          rec.tool('fs.read', 'sales-wk-01..08', 3800, 'Weekly bundle')
          rec.req(ctx({ history: 5200, toolResult: { source: 'fs.read(customer-interviews.md)', tokens: 5100, preview: 'Full interviews, window fully exhausted…' } }), 'Request assembled, estimated 15.2k tokens')
          rec.req(ctx({ history: 9400, toolResult: { source: 'fs.read(finance-q3.xlsx)', tokens: 4200, preview: 'Over-window request' } }), 'Context window exceeded', 'context_overflow')
          rec.finish({ success: false, tokens: 221_000, latencyP50: 248_000, failureModes: { 'long-horizon-decay': 2 } })
        },
      },
      {
        branchId: 'budget', config: cfg({ compression: 'budget' }),
        metrics: { ...fx(58.9, 196_000, 205_000, { 'long-horizon-decay': 1, 'context-loss': 1 }), source: S('fixture', 'Illustrative data (same trunk as five-layer, for comparison)') },
        build(rec) {
          rec.start(MODEL, 'Summarize 24 Q3 source documents and draft the Q3 Business Review report')
          rec.req(ctx({ history: 1800 }), 'First list the source documents and decide the reading order')
          rec.tool('fs.list', 'docs/q3/', 400, '24 files: 8 sales weeklies, 3 finance monthlies, 6 interviews, 7 others')
          rec.req(ctx({ history: 2600, toolResult: { source: 'fs.read(sales-wk-01..08)', tokens: 3800, preview: 'Extracted text from the Q3 sales weekly bundle…' } }), 'Batch-read the sales weeklies and extract key metrics')
          rec.tool('fs.read', 'sales-wk-01..08', 3800, 'Weekly bundle: revenue +6.2% QoQ, 1,204 new customers')
          rec.req(ctx({ history: 3400, toolResult: { source: 'fs.read(finance-q3.xlsx)', tokens: 4200, preview: 'Full finance sheet: gross margin / expense detail…' } }), 'Read the finance figures, keeping them aligned with the sales definitions')
          rec.tool('fs.read', 'finance-q3.xlsx', 4200, 'Q3 gross margin 58.1%, fulfillment cost +11% QoQ')
          rec.req(ctx({ history: 5200, toolResult: { source: 'fs.read(customer-interviews.md)', tokens: 5100, preview: 'Full text of 6 customer interviews, nearing the window…' } }), 'Window nearly full; only the budget layer is available')
          rec.compact('budget', 14_800, 13_500)
          rec.add({ type: 'shaper.fire', step: rec.step, order: 1, shaper: 'budget', freedTokens: 1300, note: 'Single overflow → replaced with a file reference' })
          rec.req(ctx({ history: 4900, toolResult: { source: 'fs.read(interviews 4-6)', tokens: 3300, preview: 'Relieved after the cut; the last 3 interviews crowd the window again…' } }), 'History was not trimmed; continue reading the last 3 interviews')
          rec.tool('fs.write', 'report/section-1-2.md', 900, 'Sections 1–2 drafted')
          rec.req(ctx({ history: 9800, toolResult: { source: 'fs.read(outline.md)', tokens: 300, preview: 'The outline is buried deep in earlier context; positional attention degrades' } }), 'Writing the risk section: section 2 figures contradict earlier text')
          rec.tag('context-loss', 0.81, 'The outline written earlier is unreachable mid-window; only its position-degraded preview remains')
          rec.tag('long-horizon-decay', 0.86, 'Late sections conflict with mid-run definitions; middle-section recall drops')
          rec.finish({ success: false, tokens: 196_000, latencyP50: 205_000, failureModes: { 'long-horizon-decay': 1, 'context-loss': 1 } })
        },
      },
      {
        branchId: 'fivelayer', config: cfg({ compression: 'five-layer' }),
        metrics: { ...fx(61.5, 168_000, 182_000), source: S('fixture', 'Illustrative data') },
        build(rec) {
          rec.start(MODEL, 'Summarize 24 Q3 source documents and draft the Q3 Business Review report')
          rec.req(ctx({ history: 1800 }), 'First list the source documents and decide the reading order')
          rec.tool('fs.list', 'docs/q3/', 400, '24 files: 8 sales weeklies, 3 finance monthlies, 6 interviews, 7 others')
          rec.req(ctx({ history: 2600, toolResult: { source: 'fs.read(sales-wk-01..08)', tokens: 3800, preview: 'Extracted text from the Q3 sales weekly bundle…' } }), 'Batch-read the sales weeklies and extract key metrics')
          rec.tool('fs.read', 'sales-wk-01..08', 3800, 'Weekly bundle: revenue +6.2% QoQ, 1,204 new customers')
          rec.req(ctx({ history: 3400, toolResult: { source: 'fs.read(finance-q3.xlsx)', tokens: 4200, preview: 'Full finance sheet: gross margin / expense detail…' } }), 'Read the finance figures, keeping them aligned with the sales definitions')
          rec.tool('fs.read', 'finance-q3.xlsx', 4200, 'Q3 gross margin 58.1%, fulfillment cost +11% QoQ')
          rec.req(ctx({ history: 5200, toolResult: { source: 'fs.read(customer-interviews.md)', tokens: 5100, preview: 'Full text of 6 customer interviews, about to exceed the window…' } }), 'Context is near the window limit; trigger the compaction pipeline')
          fireFive(rec, [1300, 2100, 1500, 5100, 1800], 14_800)
          rec.req(ctx({ history: 1500, toolResult: { source: 'context-collapse(read-only projection)', tokens: 900, preview: 'Collapsed interviews: 3 recurring complaint themes' } }), 'Context shrunk to 3.1k, full history still reconstructible; start the outline')
          rec.tool('fs.write', 'report/outline.md', 300, 'Outline: exec summary / revenue / gross margin / voice of customer / risks')
          rec.req(ctx({ history: 2900, memory: 400, toolResult: { source: 'fs.read(outline.md)', tokens: 300, preview: 'Drafting section by section per the outline' } }), 'Write sections 1–2, attaching every citation to a file path')
          rec.tool('fs.write', 'report/section-1-2.md', 900, 'Sections 1–2, 1,860 words, every citation carries a path')
          rec.req(ctx({ history: 4100, memory: 400, toolResult: { source: 'fs.read(finance-q3.xlsx#collapsed)', tokens: 700, preview: 'Gross-margin figures cross-checked against the source sheet' } }), 'After drafting, verify figures and citations section by section')
          rec.finish({ success: true, tokens: 168_000, latencyP50: 182_000, failureModes: {} })
        },
      },
    ],
  },

  // ============ Research ============
  {
    scenarioId: 'research-competitor-scan', family: 'research', familyLabel: 'Research',
    task: 'Research pricing and positioning of 3 competitors, produce a comparison memo',
    model: MODEL, traps: ['Concluding before coverage is complete', 'Fabricated citations'],
    diffPairs: [['base', 'verifier']],
    branches: [
      {
        branchId: 'base', config: cfg(),
        metrics: fx(44.0, 98_000, 121_000, { 'premature-victory': 1, 'fabricated-citation': 1 }),
        build(rec) {
          rec.start(MODEL, 'Research pricing and positioning of 3 competitors, produce a comparison memo')
          rec.req(ctx({ history: 1200 }), 'Plan the searches: pricing pages, product positioning, recent updates')
          rec.tool('web_search', 'Competitor A pricing 2026', 2200, 'Competitor A official pricing snapshot: three tiers $29/$79/$199')
          rec.req(ctx({ history: 2400, toolResult: { source: 'web_search(Competitor A pricing)', tokens: 2200, preview: 'Pricing page snapshot…' } }), 'Already have info on A and B, enough to write the memo')
          rec.tool('web_search', 'Competitor B positioning analysis', 1800, 'Third-party review: Competitor B targets small/mid teams')
          rec.tag('premature-victory', 0.91, 'Declares coverage complete with only 2 independent sources (plan called for 3 competitors)')
          rec.req(ctx({ history: 3600, toolResult: { source: 'web_search(Competitor B)', tokens: 1800, preview: 'Review summary…' } }), 'Write the memo directly, citing a "Competitor B 2026 official blog"')
          rec.tool('fs.write', 'brief/competitors.md', 800, 'Memo drafted with 4 citations (one cannot be traced to a source)')
          rec.tag('fabricated-citation', 0.94, 'The cited "Competitor B 2026 official blog" does not appear in any search result')
          rec.finish({ success: false, tokens: 98_000, latencyP50: 121_000, failureModes: { 'premature-victory': 1, 'fabricated-citation': 1 } })
        },
      },
      {
        branchId: 'verifier', config: cfg({ sensors: 'verifier', selfVerify: 'premature-victory-check' }),
        metrics: { ...fx(49.5, 121_000, 149_000), source: S('fixture', 'Illustrative data (same trunk as base, for comparison)') },
        build(rec) {
          rec.start(MODEL, 'Research pricing and positioning of 3 competitors, produce a comparison memo')
          rec.req(ctx({ history: 1200 }), 'Plan the searches: pricing pages, product positioning, recent updates')
          rec.tool('web_search', 'Competitor A pricing 2026', 2200, 'Competitor A official pricing snapshot: three tiers $29/$79/$199')
          rec.req(ctx({ history: 2400, toolResult: { source: 'web_search(Competitor A pricing)', tokens: 2200, preview: 'Pricing page snapshot…' } }), 'Have info on A and B, about to write the memo')
          rec.tool('web_search', 'Competitor B positioning analysis', 1800, 'Third-party review: Competitor B targets small/mid teams')
          rec.verifier('groundedness-verifier', 'reject', 'Plan called for 3 competitors but only 2 independent sources; citation list contains untraceable entries', 'premature-victory')
          rec.req(ctx({ history: 4100, toolResult: { source: 'web_search(Competitor B)', tokens: 1800, preview: 'Continue searching after the rejection' } }), 'Verifier rejects the premature victory: add Competitor C and trace citations')
          rec.tool('web_search', 'Competitor C pricing page', 1900, 'Competitor C pricing page: from $15/seat/month')
          rec.tool('web_search', 'Competitor B changelog official', 1500, 'Competitor B official changelog: replace the untraceable blog citation')
          rec.verifier('groundedness-verifier', 'pass', '3 competitors × 2 source types complete; every citation is traceable')
          rec.req(ctx({ history: 5600, toolResult: { source: 'web_search(Competitor C)', tokens: 1900, preview: 'Follow-up searches complete' } }), 'Write the memo, attaching a source to every sentence')
          rec.tool('fs.write', 'brief/competitors.md', 900, 'Memo drafted, all 8 citations traceable')
          rec.finish({ success: true, tokens: 121_000, latencyP50: 149_000, failureModes: {} })
        },
      },
    ],
  },

  // ============ Cross-app workflow ============
  {
    scenarioId: 'workflow-crm-export', family: 'workflow', familyLabel: 'Cross-app Workflow',
    task: "Export this quarter's churned customers from CRM, build an Excel summary, and email the CSM",
    model: MODEL, traps: ['Mis-sent email (out-of-scope action)', 'Long-horizon state loss'],
    diffPairs: [['base', 'filestate'], ['filestate', 'tuned']],
    branches: [
      {
        branchId: 'base', config: cfg(),
        metrics: { ...fx(44.4, 87_000, 132_000, { 'scope-violation': 1, 'reasoning-action-mismatch': 1 }), source: S('fixture', 'Illustrative baseline (Δ from NLAH v2: Compression −8.3 / File-backed State +13.9, OSWorld family)') },
        build(rec) {
          rec.start(MODEL, "Export this quarter's churned customers from CRM, build an Excel summary, and email the CSM")
          rec.req(ctx({ history: 1300 }), "First pull this quarter's churned-customer list")
          rec.tool('crm.query', 'churned this quarter', 2400, '412 churned records in total (including leftovers from prior quarters)')
          rec.tool('fs.write', 'export/churn-q3.csv', 300, '412 rows exported')
          rec.req(ctx({ history: 2900, toolResult: { source: 'crm.query(churned)', tokens: 2400, preview: '412 records…' } }), 'Build the summary table with breakdowns by region')
          rec.tool('xlsx.generate', 'churn-summary.xlsx', 260, 'Summary: 4 regional breakdowns + a detail sheet')
          rec.req(ctx({ history: 4100, toolResult: { source: 'xlsx.generate', tokens: 260, preview: 'Summary complete' } }), 'Draft the notification email')
          rec.tool('fs.write', 'draft-email.md', 200, 'Email draft: Q3 churn summary and key points')
          rec.req(ctx({ history: 5200, toolResult: { source: 'fs.read(draft-email.md)', tokens: 200, preview: 'Draft ready' } }), 'Finalize the recipient list')
          rec.tool('crm.query', 'contacts by segment', 3100, '412 candidates (prior quarters not filtered out)')
          rec.req(ctx({ history: 6400, toolResult: { source: 'crm.query(contacts)', tokens: 3100, preview: 'Candidate list…' } }), 'Cross-check the task spec against the recipient definition')
          rec.tool('fs.read', 'run-manifest.json', 1400, 'manifest: recipient scope = this quarter\'s churned customers (38 people)')
          rec.req(ctx({ history: 7300, toolResult: { source: 'fs.read(run-manifest.json)', tokens: 1400, preview: 'Scope: 38 churned this quarter' } }), 'Send directly to the 412 candidates (no permission gate)')
          rec.tool('mail.send', 'to: 412 contacts', 100, '412 emails sent')
          rec.tag('scope-violation', 0.97, 'Treats the candidate list as recipients: mis-sends to 374 customers who did not churn this quarter')
          rec.tag('reasoning-action-mismatch', 0.9, 'Thought says cross-check the spec, action sends to the unchecked 412 anyway')
          rec.finish({ success: false, tokens: 87_000, latencyP50: 132_000, failureModes: { 'scope-violation': 1, 'reasoning-action-mismatch': 1 } })
        },
      },
      {
        branchId: 'filestate', config: cfg({ filesystem: 'file-backed-state' }),
        metrics: { ...fx(58.3, 91_000, 128_000), source: S('paper-reproduction', 'Paper reproduction · script', 'Natural-Language Agent Harnesses, arXiv:2603.25723v2 (Table 5)') },
        build(rec) {
          rec.start(MODEL, "Export this quarter's churned customers from CRM, build an Excel summary, and email the CSM")
          rec.req(ctx({ history: 1300 }), "First pull this quarter's churned-customer list")
          rec.tool('crm.query', 'churned this quarter', 2400, '412 churned records in total (including leftovers from prior quarters)')
          rec.tool('state.write', 'state/recipients.json', 200, 'Externalize key state: recipient scope = this quarter\'s churn (38)')
          rec.tool('fs.write', 'export/churn-q3.csv', 300, '412 rows exported')
          rec.req(ctx({ history: 2900, toolResult: { source: 'crm.query(churned)', tokens: 2400, preview: '412 records…' } }), 'Build the summary table with breakdowns by region')
          rec.tool('xlsx.generate', 'churn-summary.xlsx', 260, 'Summary: 4 regional breakdowns + a detail sheet')
          rec.req(ctx({ history: 4100, toolResult: { source: 'xlsx.generate', tokens: 260, preview: 'Summary complete' } }), 'Draft the notification email')
          rec.tool('fs.write', 'draft-email.md', 200, 'Email draft: Q3 churn summary and key points')
          rec.req(ctx({ history: 5200, toolResult: { source: 'fs.read(draft-email.md)', tokens: 200, preview: 'Draft ready' } }), 'Finalize the recipient list')
          rec.tool('crm.query', 'contacts by segment', 3100, '412 candidates (prior quarters not filtered out)')
          rec.req(ctx({ history: 6400, toolResult: { source: 'crm.query(contacts)', tokens: 3100, preview: 'Candidate list…' } }), 'Cross-check the task spec against the recipient definition')
          rec.tool('state.read', 'state/recipients.json', 300, 'file-backed state: recipient scope = this quarter\'s churn (38)')
          rec.req(ctx({ history: 7300, toolResult: { source: 'state.read(recipients)', tokens: 300, preview: 'Scope locked to 38' } }), 'The externalized state file locks the scope: send to 38')
          rec.tool('mail.send', 'to: 38 CSM owners', 100, '38 emails sent, consistent with the state file scope')
          rec.finish({ success: true, tokens: 91_000, latencyP50: 128_000, failureModes: {} })
        },
      },
      {
        branchId: 'verifier', config: cfg({ permissions: 'ask-write', sensors: 'verifier' }),
        metrics: { ...fx(52.8, 124_000, 171_000), source: S('paper-reproduction', 'Paper reproduction · script', 'Natural-Language Agent Harnesses, arXiv:2603.25723v2 (Table 5): Verifier +8.4pp OSWorld') },
        build(rec) {
          rec.start(MODEL, "Export this quarter's churned customers from CRM, build an Excel summary, and email the CSM")
          rec.req(ctx({ history: 1300 }), "First pull this quarter's churned-customer list")
          rec.tool('crm.query', 'churned this quarter', 2400, '412 churned records in total')
          rec.tool('fs.write', 'export/churn-q3.csv', 300, '412 rows exported')
          rec.req(ctx({ history: 2900, toolResult: { source: 'crm.query(churned)', tokens: 2400, preview: '412 records…' } }), 'Build the summary table')
          rec.tool('xlsx.generate', 'churn-summary.xlsx', 260, 'Summary table complete')
          rec.req(ctx({ history: 4100, toolResult: { source: 'xlsx.generate', tokens: 260, preview: 'Summary complete' } }), 'Draft the notification email')
          rec.tool('fs.write', 'draft-email.md', 200, 'Email draft complete')
          rec.req(ctx({ history: 5200, toolResult: { source: 'fs.read(draft-email.md)', tokens: 200, preview: 'Draft ready' } }), 'Finalize the recipient list')
          rec.tool('crm.query', 'contacts by segment', 3100, '412 candidates')
          rec.req(ctx({ history: 6400, toolResult: { source: 'crm.query(contacts)', tokens: 3100, preview: 'Candidate list…' } }), 'Outbound send is high-risk; request authorization')
          rec.perm('mail.send(412)', 'high')
          rec.granted('mail.send(412)', 'approval-gates (human approval)')
          rec.verifier('outbound-verifier', 'reject', 'Recipient scope cannot be proven automatically: 412 candidates do not match this-quarter churn scope')
          rec.req(ctx({ history: 7200, toolResult: { source: 'verifier log feedback', tokens: 700, preview: 'Rejection fed back; re-query with a strict this-quarter filter' } }), 'Rejection is close to the acceptance gate: narrow the scope and retry once')
          rec.tool('crm.query', 'churned this quarter strict', 1800, '38 records match the strict this-quarter definition')
          rec.verifier('outbound-verifier', 'pass', '38 recipients match the strict this-quarter churn definition')
          rec.tool('mail.send', 'to: 38 CSM owners', 100, '38 emails sent; scope verified')
          rec.finish({ success: true, tokens: 124_000, latencyP50: 171_000, failureModes: {} })
        },
      },
      {
        branchId: 'compress', config: cfg({ compression: 'budget' }),
        metrics: { ...fx(36.1, 138_000, 201_000, { 'long-horizon-decay': 1, 'step-repetition': 1, 'unaware-of-stopping': 1, 'task-derailment': 1 }), source: S('fixture', 'Δ −8.3pp illustrative (NLAH v2 direction: aggressive compression summaries drift from the evaluator)') },
        build(rec) {
          rec.start(MODEL, "Export this quarter's churned customers from CRM, build an Excel summary, and email the CSM")
          rec.req(ctx({ history: 1300 }), "First pull this quarter's churned-customer list")
          rec.tool('crm.query', 'churned this quarter', 2400, '412 churned records in total')
          rec.tool('fs.write', 'export/churn-q3.csv', 300, '412 rows exported')
          rec.req(ctx({ history: 2900, toolResult: { source: 'crm.query(churned)', tokens: 2400, preview: '412 records…' } }), 'Build the summary table')
          rec.tool('xlsx.generate', 'churn-summary.xlsx', 260, 'Summary table complete')
          rec.req(ctx({ history: 9400, toolResult: { source: 'xlsx.generate', tokens: 260, preview: 'Window heavy; compress aggressively' } }), 'Context heavy; squeeze everything into a summary and proceed')
          rec.compact('budget', 14_800, 13_500)
          rec.add({ type: 'shaper.fire', step: rec.step, order: 1, shaper: 'budget', freedTokens: 1300, note: 'Single overflow → replaced with a file reference' })
          rec.req(ctx({ history: 4600, toolResult: { source: 'budget-summary', tokens: 900, preview: 'Window relieved after the cut; summary says 412 churned…' } }), 'Act on the compressed summary: prepare the 412 send')
          rec.req(ctx({ history: 8600, toolResult: { source: 'crm.query(contacts)', tokens: 3100, preview: 'Window heavy again; compress and re-read' } }), 'Compress again and re-read the scope')
          rec.compact('budget', 15_100, 13_800)
          rec.tag('step-repetition', 0.88, 'Same compress-and-act cycle retried without new evidence')
          rec.req(ctx({ history: 6400, toolResult: { source: 'budget-summary', tokens: 900, preview: 'Relieved again, but the summary still says 412…' } }), 'Keep fitting context instead of stopping or escalating')
          rec.tag('unaware-of-stopping', 0.85, 'Loop never recognizes it should stop or escalate; runs until timeout')
          rec.tag('task-derailment', 0.8, 'Objective drifts from sending the email to fitting everything into context')
          rec.tag('long-horizon-decay', 0.83, 'Aggressive summaries drift from the evaluator; task times out')
          rec.finish({ success: false, tokens: 138_000, latencyP50: 201_000, failureModes: { 'long-horizon-decay': 1, 'step-repetition': 1, 'unaware-of-stopping': 1, 'task-derailment': 1 } })
        },
      },
      {
        branchId: 'multicand', config: cfg({ sensors: 'verifier+critic', subAgents: 'context-isolated' }),
        metrics: { ...fx(47.2, 118_000, 176_000, { 'weak-grounding': 1, 'reasoning-action-mismatch': 1 }), source: S('fixture', 'Δ +2.8pp illustrative (NLAH v2: Multi-Candidate small OSWorld gain, −1.6pp on SWE)') },
      },
      {
        branchId: 'tuned', config: cfg({ filesystem: 'file-backed-state', hooks: 'lifecycle', sensors: 'verifier', permissions: 'ask-write', humanInLoop: 'approval-gates' }),
        metrics: { ...fx(56.2, 96_000, 136_000), source: S('fixture', 'Illustrative: filestate locks scope → verifier passes first try → hooks guard mail.send; all components from MRI demo') },
        build(rec) {
          rec.start(MODEL, "Export this quarter's churned customers from CRM, build an Excel summary, and email the CSM")
          // ---- Phase 1: query & externalize scope (file-backed state) ----
          rec.req(ctx({ history: 1300 }), "First pull this quarter's churned-customer list")
          rec.tool('crm.query', 'churned this quarter', 2400, '412 churned records in total (including leftovers from prior quarters)')
          rec.tool('state.write', 'state/recipients.json', 200, 'Externalize key state: recipient scope = this quarter\'s churn (38)')
          rec.tool('fs.write', 'export/churn-q3.csv', 300, '412 rows exported')
          // ---- Phase 2: build summary & draft email ----
          rec.req(ctx({ history: 2900, toolResult: { source: 'crm.query(churned)', tokens: 2400, preview: '412 records…' } }), 'Build the summary table with breakdowns by region')
          rec.tool('xlsx.generate', 'churn-summary.xlsx', 260, 'Summary: 4 regional breakdowns + a detail sheet')
          rec.req(ctx({ history: 4100, toolResult: { source: 'xlsx.generate', tokens: 260, preview: 'Summary complete' } }), 'Draft the notification email')
          rec.tool('fs.write', 'draft-email.md', 200, 'Email draft: Q3 churn summary and key points')
          // ---- Phase 3: resolve recipients via file-backed state (scope lock) ----
          rec.req(ctx({ history: 5200, toolResult: { source: 'fs.read(draft-email.md)', tokens: 200, preview: 'Draft ready' } }), 'Finalize the recipient list')
          rec.tool('crm.query', 'contacts by segment', 3100, '412 candidates (prior quarters not filtered out)')
          rec.req(ctx({ history: 6400, toolResult: { source: 'crm.query(contacts)', tokens: 3100, preview: 'Candidate list…' } }), 'Read the externalized state to lock the scope')
          rec.tool('state.read', 'state/recipients.json', 300, 'file-backed state: recipient scope = this quarter\'s churn (38)')
          // ---- Phase 4: outbound safety (hooks + verifier + approval gate) ----
          rec.req(ctx({ history: 7300, toolResult: { source: 'state.read(recipients)', tokens: 300, preview: 'Scope locked to 38' } }), 'Send the outbound email; hooks and verifier guard the action')
          rec.perm('mail.send(38)', 'medium')
          rec.hook('pre-send.recipient-scope', 'allow', 'Recipient count 38 matches state/recipients.json scope')
          rec.verifier('outbound-verifier', 'pass', 'Scope verified via file-backed state: 38 recipients match this-quarter churn definition')
          rec.granted('mail.send(38)', 'approval-gates (human approval)')
          rec.tool('mail.send', 'to: 38 CSM owners', 100, '38 emails sent; scope matches manifest')
          rec.finish({ success: true, tokens: 96_000, latencyP50: 136_000, failureModes: {} })
        },
      },
    ],
  },

  // ============ Coding (control group) ============
  {
    scenarioId: 'coding-terminal-refactor', family: 'coding', familyLabel: 'Coding (control group)',
    task: 'Fix flaky tests in the CLI output module and finish the refactor (Terminal-Bench-style container)',
    model: MODEL, traps: ['Declaring done while tests fail', 'Committing without verification'],
    diffPairs: [['base', 'tuned']],
    branches: [
      {
        branchId: 'base', config: cfg(),
        metrics: { ...fx(34.0, 41_200, 96_000, { 'premature-victory': 1 }), source: S('fixture', 'Illustrative baseline (opening demo 34%)') },
        build(rec) {
          rec.start(MODEL, 'Fix flaky tests in the CLI output module and finish the refactor')
          rec.req(ctx({ history: 900, toolSchema: 380 }), 'First reproduce the flaky test')
          rec.tool('shell', 'pytest -k output -x', 1500, '2 failed, 18 passed: test_flush_order times out')
          rec.req(ctx({ history: 2100, toolResult: { source: 'shell(pytest)', tokens: 1500, preview: 'Failing stack points to the shared buffer…' } }), 'Read the output module implementation')
          rec.tool('fs.read', 'cli/output.py', 2000, 'BufferedWriter shares a buffer with no lock')
          rec.req(ctx({ history: 3800, toolResult: { source: 'fs.read(output.py)', tokens: 2000, preview: 'Race-condition hypothesis holds…' } }), 'Hypothesis: concurrent flush race; edit the implementation directly')
          rec.tool('fs.write', 'cli/output.py', 600, 'Add a write lock + queue the flushes')
          rec.req(ctx({ history: 4700, toolResult: { source: 'fs.write', tokens: 600, preview: 'Patch written' } }), 'The change looks fine, commit directly')
          rec.tool('shell', 'git commit -m "fix: race"', 200, 'Committed (tests not run)')
          rec.tag('premature-victory', 0.95, 'Commits without test verification: the flaky case only "looks fixed"')
          rec.finish({ success: false, tokens: 41_200, latencyP50: 96_000, failureModes: { 'premature-victory': 1 } })
        },
      },
      {
        branchId: 'tuned', config: cfg({ loopControl: 'plan-act', toolset: 'standard', planner: 'todo-list', compression: 'five-layer', sensors: 'verifier', subAgents: 'context-isolated', observability: 'trace+mast' }),
        metrics: { ...fx(77.0, 63_800, 141_000), source: S('paper-reproduction', 'Paper reproduction · script', 'AHE Terminal-Bench2 final state 77.0%, arXiv:2604.25850') },
        build(rec) {
          rec.start(MODEL, 'Fix flaky tests in the CLI output module and finish the refactor')
          rec.req(ctx({ history: 900, toolSchema: 610 }), 'Reproduce, then locate, then fix: build a todo list')
          rec.tool('shell', 'pytest -k output -x', 1500, '2 failed, 18 passed: test_flush_order times out')
          rec.req(ctx({ history: 2100, toolResult: { source: 'shell(pytest)', tokens: 1500, preview: 'Failing stack points to the shared buffer…' } }), 'Read the output module implementation')
          rec.tool('fs.read', 'cli/output.py', 2000, 'BufferedWriter shares a buffer with no lock')
          rec.req(ctx({ history: 3800, toolResult: { source: 'fs.read(output.py)', tokens: 2000, preview: 'Race-condition hypothesis holds…' } }), 'Write the patch; then run the full test suite in an isolated sub-agent')
          rec.tool('fs.write', 'cli/output.py', 600, 'Add a write lock + queue the flushes')
          rec.fork('child-test-runner', 'Context-isolated: full test suite + 20 flaky reruns')
          rec.tool('shell', 'pytest -q && stress-flush 20x', 2600, '20 passed; 20 reruns all green')
          rec.join('child-test-runner', 'Full suite passed, flaky reproduced 0 times')
          rec.verifier('unit-tests', 'pass', 'All 20 cases passed; 20 flaky reruns all green')
          rec.req(ctx({ history: 5200, toolResult: { source: 'child-join(summary)', tokens: 800, preview: 'Test evidence fed back…' } }), 'Context near the limit; the five-layer compaction pipeline takes over')
          fireFive(rec, [900, 1600, 1100, 2600, 1300], 12_400)
          rec.req(ctx({ history: 1600, toolResult: { source: 'context-collapse(read-only projection)', tokens: 600, preview: 'Collapsed projection of test evidence' } }), 'Test evidence is reconstructible in the collapsed projection; commit')
          rec.tool('shell', 'git commit -m "fix: race (verified)"', 200, 'Committed')
          rec.finish({ success: true, tokens: 63_800, latencyP50: 141_000, failureModes: {} })
        },
      },
      {
        branchId: 'selfevo', config: cfg({ optimizer: 'wind-tunnel-search' }),
        metrics: { ...fx(39.8, 44_600, 104_000), source: S('fixture', 'Δ +5.8pp from NLAH Self-Evolution (SWE family, v2 Table 5); baseline illustrative') },
        build(rec) {
          rec.start(MODEL, 'Fix flaky tests in the CLI output module and finish the refactor')
          rec.req(ctx({ history: 900, toolSchema: 380 }), 'First reproduce the flaky test')
          rec.tool('shell', 'pytest -k output -x', 1500, '2 failed, 18 passed: test_flush_order times out')
          rec.req(ctx({ history: 2100, toolResult: { source: 'shell(pytest)', tokens: 1500, preview: 'Failing stack points to the shared buffer…' } }), 'Read the output module implementation')
          rec.tool('fs.read', 'cli/output.py', 2000, 'BufferedWriter shares a buffer with no lock')
          rec.req(ctx({ history: 3800, toolResult: { source: 'fs.read(output.py)', tokens: 2000, preview: 'Race-condition hypothesis holds…' } }), 'Write the patch')
          rec.tool('fs.write', 'cli/output.py', 600, 'Add a write lock + queue the flushes')
          rec.req(ctx({ history: 4700, toolResult: { source: 'fs.write', tokens: 600, preview: 'Patch written' } }), 'Run tests before committing')
          rec.optimizer('wind-tunnel-search', 'self-check inject', 'Run the full test suite before committing; skip = reject')
          rec.tool('shell', 'pytest -k output', 1200, '19 passed, 1 failed: the stress case still times out')
          rec.req(ctx({ history: 5600, toolResult: { source: 'shell(pytest)', tokens: 1200, preview: 'Stress case not covered' } }), 'Self-evolution: add stress reruns, then commit')
          rec.optimizer('wind-tunnel-search', 'self-evolution trigger', 'Detected uncovered edge case; expanding rerun scope before commit')
          rec.tool('shell', 'pytest -q && stress-flush 20x', 1400, '20 passed; committed')
          rec.finish({ success: true, tokens: 44_600, latencyP50: 104_000, failureModes: {} })
        },
      },
      {
        branchId: 'ahe-gen0', config: cfg({ toolset: 'standard', observability: 'trace' }),
        metrics: { ...fx(69.7, 58_000, 132_000), source: S('paper-reproduction', 'Paper reproduction · script', 'AHE start 69.7%, arXiv:2604.25850') },
      },
      {
        branchId: 'r1-batch', config: cfg({ toolset: 'standard', observability: 'trace', eval: 'golden-set' }),
        metrics: { ...fx(41.6, 66_000, 158_000), source: S('paper-reproduction', 'Paper reproduction · script', 'Harness-R1 baseline batch 41.6%, arXiv:2608.02276') },
      },
      {
        branchId: 'r1-naive', config: cfg({ toolset: 'standard', observability: 'trace', sensors: 'verifier+critic', loopControl: 'reflexion' }),
        metrics: { ...fx(35.4, 78_000, 189_000, { 'spec-misinterpretation': 1 }), source: S('paper-reproduction', 'Paper reproduction · script', 'Harness-R1 naive self-patch 35.4% (−6.2pp), arXiv:2608.02276') },
      },
    ],
  },

  // ============ Data analysis ============
  {
    scenarioId: 'analysis-churn-metrics', family: 'analysis', familyLabel: 'Data Analysis',
    task: 'Compute the Q3 churn rate of the subscription service and attribute the causes',
    model: MODEL, traps: ['Definition/scope errors', 'Conclusions not backed by data'],
    diffPairs: [['base', 'checklist']],
    branches: [
      {
        branchId: 'base', config: cfg(),
        metrics: fx(50.5, 36_000, 64_000, { 'spec-misinterpretation': 1, 'weak-grounding': 1, 'fail-to-clarify': 1 }),
        build(rec) {
          rec.start(MODEL, 'Compute the Q3 churn rate of the subscription service and attribute the causes')
          rec.req(ctx({ history: 700, toolSchema: 420 }), 'First inspect the subscriptions table schema')
          rec.tool('db.schema', 'subscriptions', 800, 'Fields: status(active/paused/churned), period, plan')
          rec.req(ctx({ history: 1500, toolResult: { source: 'db.schema', tokens: 800, preview: 'status enum includes paused…' } }), 'Sample three months of data')
          rec.tool('db.query', 'monthly active & cancels', 2600, 'Jul–Sep: active 42k, canceled 1.9k, paused 312')
          rec.tag('spec-misinterpretation', 0.88, 'Counts paused (suspended) accounts into the churn definition')
          rec.req(ctx({ history: 3300, toolResult: { source: 'db.query', tokens: 2600, preview: 'Monthly records…' } }), 'Compute directly: churn = canceled / active')
          rec.tool('compute', 'canceled/active', 400, 'churn = 4.2%')
          rec.tag('weak-grounding', 0.82, 'Conclusion states no definition: the 312 paused records are unaccounted for')
          rec.tag('fail-to-clarify', 0.84, 'Status enum is ambiguous (paused vs churned); agent computes instead of clarifying the definition')
          rec.finish({ success: false, tokens: 36_000, latencyP50: 64_000, failureModes: { 'spec-misinterpretation': 1, 'weak-grounding': 1, 'fail-to-clarify': 1 } })
        },
      },
      {
        branchId: 'checklist', config: cfg({ guides: 'domain-checklist', sensors: 'lint' }),
        metrics: { ...fx(57.0, 41_000, 72_000), source: S('fixture', 'Illustrative data (same trunk as base, for comparison)') },
        build(rec) {
          rec.start(MODEL, 'Compute the Q3 churn rate of the subscription service and attribute the causes')
          rec.req(ctx({ history: 700, toolSchema: 420, memory: 300 }), 'Inspect the schema first; the checklist prompts: confirm the status enum definitions')
          rec.tool('db.schema', 'subscriptions', 800, 'Fields: status(active/paused/churned), period, plan')
          rec.req(ctx({ history: 1500, toolResult: { source: 'db.schema', tokens: 800, preview: 'status enum includes paused…' } }), 'Sample three months of data')
          rec.tool('db.query', 'monthly active & cancels', 2600, 'Jul–Sep: active 42k, canceled 1.9k, paused 312')
          rec.req(ctx({ history: 3300, toolResult: { source: 'db.query', tokens: 2600, preview: 'Monthly records…' } }), 'Run the definition check before computing')
          rec.lint('definition-check', 'reject', '312 paused records unhandled: definition does not distinguish paused from churned')
          rec.req(ctx({ history: 4100, toolResult: { source: 'lint log feedback', tokens: 400, preview: 'Rejection feedback…' } }), 'Count paused and churned separately')
          rec.tool('db.query', 'group by status', 1800, 'All 312 paused are still within their subscription period')
          rec.req(ctx({ history: 4900, toolResult: { source: 'db.query(group by)', tokens: 1800, preview: 'Definition aligned' } }), 'Recompute churn with a definitional footnote')
          rec.tool('compute', 'canceled/(active+canceled)', 400, 'churn = 3.1% (paused excluded, definitional footnote attached)')
          rec.lint('definition-check', 'pass', 'Definition clear; figures are recomputable from source data')
          rec.finish({ success: true, tokens: 41_000, latencyP50: 72_000, failureModes: {} })
        },
      },
    ],
  },
]

// ---------- Forge ten-generation data (AHE curve + Harness-R1 counter-example card) ----------
const forge = {
  source: [
    { kind: 'paper-reproduction', label: 'Paper reproduction · script', citation: 'AHE ten-generation curve 69.7→77.0, arXiv:2604.25850' },
    { kind: 'paper-reproduction', label: 'Paper reproduction · script', citation: 'Harness-R1 counter-example card, arXiv:2608.02276' },
  ] as SourceRef[],
  scenarioId: 'coding-terminal-refactor',
  startScore: 69.7,
  endScore: 77.0,
  gens: [
    {
      gen: 1, gain: 0.8, verdict: 'approved', approvedBy: 'human',
      cluster: { mast: 'premature-victory', count: 7, summary: '7 trajectories committed without running the full test suite', sampleBranches: ['base'] },
      card: {
        seam: '⑬ Feedback Sensors & Lints', title: 'Mandatory full test run before commit',
        nl: 'Insert a deterministic verifier before commit: allow committing only when pytest is fully green and flaky reruns pass.',
        diff: '+ sensors: verifier\n+ selfVerify: premature-victory-check',
        prediction: { gainPp: [0.5, 1.2] as [number, number] },
      },
      falsification: { rescued: 5, regressed: 0, detail: 'Replay of 9 task trajectories: 5 rescued, 0 regressed, consistent with the predicted range' },
    },
    {
      gen: 2, gain: 1.3, verdict: 'approved', approvedBy: 'human',
      cluster: { mast: 'long-horizon-decay', count: 4, summary: 'Late-stage long tasks overflow context and early evidence gets pushed out', sampleBranches: ['tuned'] },
      card: {
        seam: '⑧ Context Compression', title: 'Replace single-layer budget with the five-layer compaction pipeline',
        nl: 'Enable budget→snip→microcompact→collapse→auto-compact in cheapest-to-most-expensive order.',
        diff: '~ compression: budget → five-layer',
        prediction: { gainPp: [0.8, 1.8] as [number, number] },
      },
      falsification: { rescued: 3, regressed: 0, detail: 'All 4 long-task trajectories flipped to success' },
    },
    {
      gen: 3, gain: 0.5, verdict: 'approved', approvedBy: 'human',
      cluster: { mast: 'spec-misinterpretation', count: 3, summary: 'Misreads the test spec: runs only cases related to the change', sampleBranches: ['selfevo'] },
      card: {
        seam: '⑫ Feedforward Guidelines', title: 'Encode the "full test suite" definition in AGENTS.md',
        nl: 'The guide states: the full pytest suite must run before any commit; running only a -k subset is not allowed.',
        diff: '+ guides: style-rules (AGENTS.md addition)',
        prediction: { gainPp: [0.2, 0.8] as [number, number] },
      },
      falsification: { rescued: 2, regressed: 0, detail: '2 of 3 trajectories rescued; 1 overlaps with the verifier and does not stack' },
    },
    {
      gen: 4, gain: 1.0, verdict: 'approved', approvedBy: 'human',
      cluster: { mast: 'long-horizon-decay', count: 3, summary: 'Full test output is fed back and crowds the context', sampleBranches: ['tuned'] },
      card: {
        seam: '⑩ Lifecycle Hooks', title: 'Persist test output to disk, feed back only a summary',
        nl: 'PostToolUse hook: write pytest output to /tmp/last-test.log and feed back only the failing stack.',
        diff: '+ hooks: lifecycle (post:test → truncate)',
        prediction: { gainPp: [0.6, 1.4] as [number, number] },
      },
      falsification: { rescued: 3, regressed: 0, detail: 'All 3 long-output trajectories rescued' },
    },
    {
      gen: 5, gain: 0.6, verdict: 'approved', approvedBy: 'human',
      cluster: { mast: 'weak-grounding', count: 3, summary: 'Fix descriptions lack evidence links', sampleBranches: ['tuned'] },
      card: {
        seam: '⑩ Lifecycle Hooks', title: 'Require test evidence in the commit message',
        nl: 'PreCommit hook validates that the commit message contains the test run identifier.',
        diff: '+ hooks: lifecycle (pre:commit → evidence)',
        prediction: { gainPp: [0.3, 0.9] as [number, number] },
      },
      falsification: { rescued: 2, regressed: 1, detail: '2 rescued, 1 regressed (a style conflict); net gain positive' },
    },
    {
      gen: 6, gain: -6.2, verdict: 'rejected', approvedBy: 'human', // measured wind-tunnel delta (41.6 → 35.4); lands on the score curve only if a human overrides to approve
      cluster: { mast: 'spec-misinterpretation', count: 2, summary: "The model's self-reflection rule conflicts with the task goal", sampleBranches: ['r1-naive'] },
      card: {
        seam: '① Loop Control Flow', title: 'Add a fixed Self-Refine rule (counter-example)',
        nl: 'Force one self-reflection rewrite after every turn. [Harness-R1 evidence: this fixed rule lowered scores on all 3 benchmarks]',
        diff: '~ loopControl: plan-act → reflexion',
        prediction: { gainPp: [1.0, 1.5] as [number, number] },
      },
      falsification: { rescued: 1, regressed: 3, detail: '1 rescued, 3 regressed: 41.6% → 35.4% (−6.2pp). Regression → an automatic rollback point is created and the human rejects this card' },
    },
    {
      gen: 7, gain: 1.2, verdict: 'approved', approvedBy: 'human',
      cluster: { mast: 'premature-victory', count: 2, summary: 'Sub-agent conclusions are fed back without verification', sampleBranches: ['tuned'] },
      card: {
        seam: '⑤ Sub-Agent Isolation', title: 'Test sub-agent conclusions must carry a raw-log summary',
        nl: 'On join, verify the child summary against the logs; reject if inconsistent.',
        diff: '~ subAgents: context-isolated (+join verification)',
        prediction: { gainPp: [0.8, 1.6] as [number, number] },
      },
      falsification: { rescued: 4, regressed: 0, detail: 'All 4 sub-agent trajectories flipped' },
    },
    {
      gen: 8, gain: 0.7, verdict: 'approved', approvedBy: 'human',
      cluster: { mast: 'long-horizon-decay', count: 2, summary: 'Earlier localization findings are lost after a restart', sampleBranches: ['tuned'] },
      card: {
        seam: '③ File System & State', title: 'Externalize localization findings to file-backed state',
        nl: 'Write hypotheses/evidence to state/findings.json and restore from it each turn.',
        diff: '+ filesystem: file-backed-state',
        prediction: { gainPp: [0.4, 1.0] as [number, number] },
      },
      falsification: { rescued: 2, regressed: 0, detail: '2 resume-from-checkpoint trajectories rescued' },
    },
    {
      gen: 9, gain: 1.2, verdict: 'approved', approvedBy: 'autoplay-gate', // Autoplay mode also stops at the approval gate
      cluster: { mast: 'weak-grounding', count: 2, summary: 'No comparison against the old-behavior baseline after refactoring', sampleBranches: ['selfevo'] },
      card: {
        seam: '⑰ Golden Evaluation Set', title: 'Bring the golden behavior baseline into the loop',
        nl: 'For refactoring tasks, record a snapshot of old behavior first and diff against that baseline before commit.',
        diff: '+ eval: golden-set',
        prediction: { gainPp: [0.7, 1.5] as [number, number] },
      },
      falsification: { rescued: 3, regressed: 1, detail: '3 rescued, 1 regressed, net gain still positive; after Autoplay stops at the gate, a human approves in batch' },
    },
  ],
}

// ---------- Generation ----------
const scenarioMetas: { scenarioId: string }[] = []

for (const sc of scenarios) {
  const dir = resolve(OUT, 'scenarios', sc.scenarioId)
  const bdir = resolve(dir, 'branches')
  mkdirSync(bdir, { recursive: true })

  const branches: ScenarioMeta['branches'] = []
  const metrics: Record<string, MetricsEntry> = {}
  const fps = new Set<string>()

  for (const b of sc.branches) {
    const fp = fingerprint(b.config)
    if (fps.has(fp)) throw new Error(`fingerprint collision in ${sc.scenarioId}: ${b.branchId}`)
    fps.add(fp)
    metrics[fp] = b.metrics
    if (b.build) {
      const runId = `${sc.scenarioId}#${b.branchId}`
      const rec = new Rec(runId, sc.scenarioId)
      b.build(rec)
      for (const e of rec.evs) eventSchema.parse(e)
      const file = `${b.branchId}.jsonl`
      writeFileSync(resolve(bdir, file), rec.evs.map((e) => JSON.stringify(e)).join('\n') + '\n')
      branches.push({ branchId: b.branchId, fingerprint: fp, config: b.config, file })
    } else {
      // Metrics-only branch: indexed in branches (for the metric matrix and presets) but has no trajectory file
      branches.push({ branchId: b.branchId, fingerprint: fp, config: b.config, file: '' })
    }
  }

  const meta: ScenarioMeta = {
    scenarioId: sc.scenarioId, family: sc.family, familyLabel: sc.familyLabel,
    task: sc.task, model: sc.model, traps: sc.traps, diffPairs: sc.diffPairs, branches, metrics,
  }
  writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta, null, 2))
  scenarioMetas.push({ scenarioId: sc.scenarioId })
  console.log(`✓ ${sc.scenarioId}: ${sc.branches.length} branches`)
}

writeFileSync(resolve(OUT, 'scenarios', 'index.json'), JSON.stringify(scenarioMetas, null, 2))
mkdirSync(resolve(OUT, 'forge'), { recursive: true })
writeFileSync(resolve(OUT, 'forge', 'generations.json'), JSON.stringify(forge, null, 2))
console.log(`✓ forge: ${forge.gens.length} generations`)
console.log('done.')
