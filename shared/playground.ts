// Live Playground (M1+) shared types — the patent judicial-review scenario.
// Fixture screens (MRI/tunnel/Forge/security/legal) stay untouched; this file
// only serves the new #/playground screen and its /api/playground routes.
import type { HarnessConfig } from './config'
import type { HarnessEvent } from './events'
import type { LegalAssertion, LegalControl } from './legal'
import type { SecurityControl } from './redteam'
import type { MastTag } from './mast'

export type PgDomain = 'general' | 'legal' | 'security'
export type PgSplit = 'repair' | 'gate' | 'scorecard'
export type ScorerType = 'field-match' | 'article-check' | 'trap-check' | 'gate-check' | 'leak-check'

export type EvalTaskSource = 'led-heatsink' | 'golden-review' | 'evalset-reexam' | 'authored'

/**
 * A gold fact for deterministic field matching.
 * - `match` holds AND groups; every group must be found.
 * - A group uses "|" to separate synonym variants (OR within the group).
 *   e.g. ["压铸|一体压铸|压铸成型", "翅片", "2-5mm|2～5mm|2~5mm"]
 */
export interface GoldFact {
  id: string
  label: string
  match: string[]
}

/** Structured statute / guideline citation the answer is expected to rely on. */
export interface ExpectedArticle {
  id: string
  /** Law alias resolved by server/playground/articles.ts (see LAW_ALIASES). */
  law: string
  /** Article number in Arabic numerals, e.g. "22". */
  article?: string
  /** Clause (款) in Arabic numerals, e.g. "2" → 第二款. */
  clause?: string
  /** Item (项) in Arabic numerals. */
  item?: string
  /** Examination guideline section path, e.g. "第二部分第四章3.2.1.1". */
  section?: string
  /** Display label, e.g. "专利法第22条第2款（新颖性）". */
  label: string
  /** Terms that MUST appear in the statute's own text (proves the number maps to the right rule). */
  articleKeywords: string[]
  /** Key concepts the answer should surface when applying this citation. */
  answerKeywords?: string[]
}

export interface InjectionTrap {
  /** Dossier file that carries the injected instruction. */
  location: string
  /** The injected instruction text verbatim. */
  payload: string
  /** AND groups (| = synonyms) whose presence in the answer means the trap fired. */
  goalPhrases: string[]
  /** AND groups indicating the model correctly ignored/refused the injection. */
  refusalPhrases?: string[]
}

export interface SensitiveField {
  kind: 'id-card' | 'bank-card' | 'phone' | 'name' | 'case-internal' | 'contact' | 'custom'
  label: string
  /** Regex source (evaluated with new RegExp). One of pattern/literal must be set. */
  pattern?: string
  /** Literal substring to redact. */
  literal?: string
  /** Sample value embedded in the dossier/question for M1 sandbox scoring. */
  sample: string
}

export interface OverreachSpec {
  /** The out-of-authority request the user/data makes. */
  request: string
  /** AND groups (| = synonyms) a proper deny-first refusal should contain. */
  refusalPhrases: string[]
  /** AND groups whose presence means the forbidden content was handed over. */
  forbiddenPhrases: string[]
}

export interface EvalTask {
  id: string
  domain: PgDomain
  split: PgSplit
  scorerType: ScorerType
  source: EvalTaskSource
  /** Source question id in the sibling patentExaminator sets, when ported. */
  sourceRef?: string
  title: string
  query: string
  /** Dossier manifest file names this question is grounded in. */
  dossierFiles?: string[]
  /** The 9 signature tasks (G1-3 / L1-3 / S1-3) pinned on top. */
  signature?: boolean

  // ── gold (channel A: pre-annotated) ──
  facts?: GoldFact[]
  expectedArticles?: ExpectedArticle[]
  /** Anti-fabrication question: the cited rule does not exist; model must say so. */
  antiHallucination?: {
    fakeCitation: string
    /** AND groups (| = synonyms) showing the model recognised the citation is not real. */
    recognitionPhrases: string[]
  }
  injectionTrap?: InjectionTrap
  sensitiveFields?: SensitiveField[]
  overreach?: OverreachSpec
  /** Benign security control: the question is legitimate; refusing = over-refusal. */
  benign?: boolean
  variantOf?: string

  // ── Scorer Sandbox samples ──
  referenceAnswer: string
  /** Hand-written wrong answer for signature tasks; others are generated. */
  badAnswer?: string
  badAnswerKind?: 'missing-facts' | 'fake-article' | 'leak' | 'injection-obeyed' | 'overreach-granted' | 'over-refuse'
  notes?: string
}

// ── Score results ──

export interface FactCheck {
  id: string
  label: string
  hit: boolean
  matchedTerms: string[]
  missingTerms: string[]
}

export type ArticleAssertion = LegalAssertion

export interface ArticleCheckResult {
  id: string
  label: string
  law: string
  article?: string
  clause?: string
  item?: string
  section?: string
  articleExists: boolean
  assertion: ArticleAssertion
  /** Short snippet of the located statute text (normalized), for the UI. */
  articleSnippet?: string
  answerKeywordHits: string[]
  answerKeywordMisses: string[]
  detail: string
}

export interface SecurityCheck {
  kind: 'injection' | 'overreach' | 'leak' | 'benign-overrefuse'
  passed: boolean
  detail: string
  hits: string[]
}

export interface AntiHallucinationCheck {
  recognized: boolean
  detail: string
}

export interface ScoreResult {
  taskId: string
  scorerType: ScorerType
  success: boolean
  /** 0..1 overall. */
  score: number
  factChecks: FactCheck[]
  articleChecks: ArticleCheckResult[]
  securityChecks: SecurityCheck[]
  antiHallucination?: AntiHallucinationCheck
  /** Deterministically inferred first-class failure tags (12-tag vocabulary). */
  failureTags: MastTag[]
  summary: string
}

export interface PlaygroundTaskList {
  scenarioId: string
  scenarioName: string
  total: number
  tasks: EvalTask[]
}

// ─────────────────────────────────────────────────────────────────────────
// M2 live runs — wire types shared by server/playground/* and the screen.
// ─────────────────────────────────────────────────────────────────────────

export type PgPresetId = 'C0' | 'C1' | 'C2' | 'C3'
export type RunStatus = 'queued' | 'running' | 'scored' | 'error'
export type RunSource = 'live' | 'imported'
export type LadderRung = 'bare' | 'soft-cn' | 'soft-us' | 'hard'

/** Playground-only capability switches that have no 20-field DSL slot. */
export interface PgMounts {
  patentLawMcp?: boolean
}

export interface PgPreset {
  id: PgPresetId
  name: string
  domainFocus: '—' | PgDomain
  summary: string
  config: HarnessConfig
  mounts: PgMounts
}

export interface ControlsSnapshot {
  security: Record<SecurityControl, boolean>
  legal: Record<LegalControl, boolean>
}

export interface ProviderSnapshot {
  providerId: string
  baseUrl: string
  model: string
}

export interface DossierMaterialInfo {
  file: string
  txt: string
  sha256: string
  chars: number
}

export interface MaterialsInfo {
  dossier: DossierMaterialInfo[]
  legalKb: { sources: number; chunks: number; digest: string }
}

export interface RunSummary {
  runId: string
  taskId: string
  taskTitle: string
  domain: PgDomain
  split: PgSplit
  presetId: PgPresetId | null
  fingerprint: string
  status: RunStatus
  source: RunSource
  /** L2 scorer success (NOT run.finished.success — design §15.3 rule 1). */
  success: boolean | null
  score: number | null
  tokens: number | null
  latencyMs: number | null
  failureTags: MastTag[]
  model: string
  temperature: number | null
  seed: number | null
  eventCount: number
  hasTrajectory: boolean
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface ConfigVersionInfo {
  controlsSnapshot: ControlsSnapshot
  mappingVersion: string
  ladderRung: LadderRung
  ladderVersion: string
}

export interface RunDetail extends RunSummary {
  scenarioId: string
  config: HarnessConfig
  mounts: PgMounts
  provider: ProviderSnapshot | null
  maxTokens: number | null
  answer: string | null
  verdict: ScoreResult | null
  events: HarnessEvent[]
  materials: MaterialsInfo | null
  configVersion: ConfigVersionInfo
}

export interface CreateRunsRequest {
  taskIds: string[]
  presetId?: PgPresetId
  /** Raw 20-field config; when given, presetId is ignored. */
  config?: HarnessConfig
  mounts?: PgMounts
  providerId?: string
  model?: string
  temperature?: number
  seed?: number
  /** Hard total-token ceiling for the run (budget guard). */
  maxTokens?: number
}

export interface ChatTarget {
  providerId: string
  name: string
  baseUrl: string
  model: string
  models: string[]
  enabled: boolean
  hasKey: boolean
}

export interface RunTargets {
  providers: ChatTarget[]
  kb: { sources: number; chunks: number; embedderConfigured: boolean; ready: boolean }
}

export interface LiveMetricGroup {
  presetId: PgPresetId | null
  fingerprint: string
  runs: number
  successRate: number | null
  avgTokens: number | null
  avgLatencyMs: number | null
  /** Paired success-rate lift in percentage points vs C0 on shared tasks. */
  liftVsC0Pp: number | null
  byDomain: Partial<Record<PgDomain, { runs: number; successRate: number | null }>>
  tags: Partial<Record<MastTag, number>>
}

export interface LiveMetrics {
  totalRuns: number
  scoredRuns: number
  groups: LiveMetricGroup[]
}

/** Native export envelope (design §14.1). Round-trips through /runs/import. */
export interface PlaygroundRunFile {
  kind: 'hwt-playground-run'
  schemaVersion: 1
  exportedAt: string
  run: Omit<RunDetail, 'events'>
  events: HarnessEvent[]
}
