// Live Playground (M1+) shared types — the patent judicial-review scenario.
// Fixture screens (MRI/tunnel/Forge/security/legal) stay untouched; this file
// only serves the new #/playground screen and its /api/playground routes.
import type { HarnessConfig } from './config'
import type { JevJudgeResult } from './jev'
import type { HarnessEvent } from './events'
import type { LegalAssertion, LegalControl } from './legal'
import type { SecurityControl, KillChainStage } from './redteam'
import type { MastTag } from './mast'

export type PgDomain = 'general' | 'legal' | 'security'
export type PgSplit = 'repair' | 'gate' | 'scorecard'
export type ScorerType = 'field-match' | 'article-check' | 'trap-check' | 'gate-check' | 'leak-check'

/** L0 designed attack chain attached to a security question (design §15.2). */
export interface AttackChainSpec {
  /** Fixture attack case id in data/redteam/attacks.json (design state, L0). */
  attackId: string
  /** Stages this attack actually walks in the pure-text scenario. */
  expectedStages: KillChainStage[]
}

/** One stage's measured state (L2, derived from the run's event stream). */
export interface ObservedStage {
  stage: KillChainStage
  /**
   * blocked   — a control point stopped it (evidence below names which)
   * breached  — it got through (sensitive data left)
   * safe      — attack reached this stage but no sensitive data left (DLP not needed)
   * n/a       — the text scenario has no real event source for this stage
   * not-reached — in the expected chain, but the run never got that far
   */
  status: 'blocked' | 'breached' | 'safe' | 'n/a' | 'not-reached'
  /** Control point that blocked it (design §11.1#6: must name which one). */
  blockedBy?: string
  /** Event ids proving the verdict — the row is reproducible from these. */
  evidenceEventIds: string[]
  note: string
}

/** L2 kill-chain observation for one run (never overwrites the design state). */
export interface KillChainObservation {
  runId: string
  taskId: string
  attackId: string | null
  /** Bumped when the stage-mapping rules change; observations are versioned. */
  deriveVersion: string
  observedStages: ObservedStage[]
  /** Tools / data actually reached at the deepest breach. */
  observedBlastRadius: string[]
  /** Any stage actually reached the model = the attack landed. */
  breached: boolean
}

/** One reachable tool / data source, with how it was reached. */
export interface BlastRadiusEntry {
  /** Tool name from tool.call, or a gate scope (e.g. nonpublic-case-materials). */
  target: string
  via: 'tool-call' | 'permission-gate' | 'egress-dlp'
  reached: boolean
  evidenceEventIds: string[]
}

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
  /**
   * Whether the question actually asks for this point. Defaults to true.
   *
   * `success` means "answered everything the question asked", so a point the
   * question never asks for must not gate it — that makes the task impossible
   * to pass however well it is answered. Mark such a point `required: false`:
   * it stays visible as extra credit but leaves both `success` and the `score`
   * denominator alone. Prefer rewriting the question to ask for the point when
   * the point is what the task is really about.
   */
  required?: boolean
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
  /**
   * L0 designed attack chain for this question (design §15.2/§11.1#6-7).
   * `expectedStages` is the chain this attack actually walks in the text
   * scenario — stages outside it are reported N/A, never hard-filled.
   * `attackId` points at a data/redteam/attacks.json case whose *designed*
   * stages are the fixture's design state; the run's measured state is
   * derived separately and the two never overwrite each other.
   */
  attackChain?: AttackChainSpec

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
  /** False = extra credit: shown, but excluded from `success` and from `score`. */
  required: boolean
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

/**
 * Reference-based reading from ROUGE (Lin, 2004), computed by
 * `server/playground/rouge.ts`. Reported next to the per-point checks rather than
 * replacing them: it answers "how much of the reference answer is present",
 * which no keyword group can, but it is blind to *where* in the answer a term
 * appears, which the per-point checks are not.
 */
export interface RougeReading {
  /** ROUGE-1, recall-weighted (β = 32). */
  rouge1: number
  /** ROUGE-L, recall-weighted. */
  rougeL: number
  /** ROUGE-1 at the textbook β = 1, for comparability with published numbers. */
  rouge1F: number
  /** ROUGE-L at the textbook β = 1. */
  rougeLF: number
  /** Reference length in tokens — a thin reference makes every score noisy. */
  referenceTokens: number
}

export interface ScoreResult {
  taskId: string
  scorerType: ScorerType
  success: boolean
  /** 0..1 overall. */
  score: number
  /** ROUGE against the task's reference answer. Absent only on hand-built fixtures. */
  rouge?: RougeReading
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
  /** 卷宗正文。只在导出时填充（export-only），不落库——见 liveRoutes.envelopeFor。 */
  text?: string
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
  /** Jev side review, present only when the Jev switch was on for this run. */
  jevResult: JevJudgeResult | null
  events: HarnessEvent[]
  materials: MaterialsInfo | null
  configVersion: ConfigVersionInfo
  /**
   * Designed vs measured attack chain, kept under separate names so neither
   * can overwrite the other (design §11.1#7). `designed` is the fixture
   * catalogue's chain for the attack this question exercises; `observed` is
   * derived from this run's own event stream.
   */
  security: {
    designed: {
      attackId: string
      title: string
      designedStages: { stage: KillChainStage; status: 'blocked' | 'breached'; note: string }[]
      designedBlastRadius: string[]
    } | null
    observed: KillChainObservation | null
    blastRadius: BlastRadiusEntry[]
  }
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
  /**
   * decision = the Jev adjudication cards. They carry a key but have no
   * /chat/completions, so the server never picks them as a live run's model
   * (see llmClient.resolveChatTargets). The UI must not offer them either.
   */
  kind: 'chat' | 'decision'
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
