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

/** Search / review query for the live run list (M3). All fields optional. */
export interface RunsQuery {
  taskId?: string
  domain?: PgDomain
  fingerprint?: string
  presetId?: PgPresetId
  model?: string
  tag?: MastTag
  source?: RunSource
  status?: RunStatus
  /** ISO timestamps. */
  from?: string
  to?: string
  limit?: number
}

/** Playground-only capability switches that have no 20-field DSL slot. */
export interface PgMounts {
  patentLawMcp?: boolean
  /**
   * M4 prompt-surface evolution: a custom guidance / checklist paragraph
   * proposed by the LLM, appended to the system prompt without touching the
   * 20-field DSL (design §7.4 prompt-only edit). Null on every preset.
   */
  customGuideText?: string
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
  /**
   * Display name of this run's harness configuration, resolved from the
   * configuration itself (preset id, or a stable name for an evolved
   * generation) rather than read off a run. Every view must use this so one
   * configuration never appears under two different names.
   */
  configLabel: string
  /** Hover text for `configLabel`; null when the short label says enough. */
  configTitle: string | null
  status: RunStatus
  source: RunSource
  /** L2 scorer success (NOT run.finished.success — design §15.3 rule 1). */
  success: boolean | null
  score: number | null
  tokens: number | null
  latencyMs: number | null
  /**
   * L3 estimated USD cost (token × provider×model rate). Null when the price
   * table has no entry — never fabricated (design §11.2 / §14).
   */
  costUsd: number | null
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
  /** Same display name the run list uses for this configuration. */
  label: string
  /** Hover text for `label`; null when the short label says enough. */
  title: string | null
  runs: number
  /**
   * Distinct eval tasks this group actually ran. `runs` counts repeats, and
   * configs here are not run on the same task set — so this is the real sample
   * size, and the UI must show it next to `runs`.
   */
  distinctTasks: number
  successRate: number | null
  avgTokens: number | null
  avgLatencyMs: number | null
  /** L3 mean USD cost; null when no priced runs in the group. */
  avgCostUsd: number | null
  /**
   * Task-paired success-rate lift in percentage points vs C0: the mean of
   * (this group's per-task rate − C0's per-task rate) over the tasks both
   * groups ran, each task counted once regardless of how often it was repeated.
   *
   * This is NOT `successRate − C0 successRate`. The two columns answer
   * different questions — a config can post a high success rate purely by
   * having been run on easier tasks. Always render `liftPairedTasks`
   * alongside it so the reader can see how narrow the comparison is.
   */
  liftVsC0Pp: number | null
  /** Distinct tasks the lift was computed over; null when there was no lift. */
  liftPairedTasks: number | null
  /**
   * Reliability lower-tail of the per-task lift distribution (Airbnb PRISM
   * family, PRD §5.3) — all three read the same paired-task lifts behind
   * `liftVsC0Pp` (which is their mean). Computed from data already on disk:
   * bootstrap resampling is local math, never a model call.
   */
  /** Worst paired-task lift in pp; can be negative. Null when no lift. */
  worstLiftPp: number | null
  /** Share of paired tasks where this config beat C0 (0–1). Null when no lift. */
  rr0: number | null
  /** 5th percentile of the bootstrapped mean-lift distribution, pp. Null when no lift. */
  relLift95Pp: number | null
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

// ── M4 evolution (PRISM, §7) ───────────────────────────────────────────────

export type EvoSurface = 'prompt' | 'middleware' | 'joint'

/**
 * Run profile. Both the self-evolution screen and the held-out gate read it, so
 * one switch changes the cost of every card — not of one card.
 *
 * 'full'  — the measured口径: 6 failed + 3 guard tasks screened once each, the
 *           whole held-out gate set at the chosen ×repeats.
 * 'demo'  — the演示口径: 3 failed + 1 guard task at ×1, 3 held-out tasks at ×1.
 *           Still every single run is a real execution; only the sample shrinks,
 *           so the panel must label the sample size rather than quote a lift.
 *
 *           Which three, and why not four: a gate task has to be DECIDABLE at the
 *           demo's sample size — its baseline has to be reproducible, or a single
 *           flipped repeat decides the verdict. G11 (0/7) and L12 (0/7) never pass
 *           at all, and S6 (2/7) is the one task the safety floor is aimed at.
 *           G9 was in the first demo set and had to go: its baseline passes 4 of 7,
 *           so it is a coin flip, and its candidate reading (4/14) is inside the
 *           noise of its own baseline (Fisher p≈0.19). At four pairs that task can
 *           only contribute false regressions — it stays in the full 13-task gate,
 *           where the repeats are high enough to mean something.
 *
 *           ×1 rather than ×2: at ×1 the whole demo is 14 real runs (8 screened +
 *           6 gate) and lands in about two minutes, which is what makes it
 *           demoable at all. Repeating each task twice only ever bought the
 *           ability to tell a flip from a coin flip, and that ability is now
 *           bought a cheaper way: the judge is handed the harness's own
 *           deterministic point checks instead of being left to re-derive them
 *           from the answer's wording (see buildJudgeState). With the reading no
 *           longer swinging on phrasing, one pair per task is enough — a task
 *           that flips on one pair and not the next is the failure mode the
 *           repeats were insurance against, and that insurance is now upstream.
 *           The guard task stays at 1: it exists to catch a regression, and the
 *           guard pool is drawn from tasks that pass at the parent fingerprint.
 */
export type EvoProfile = 'full' | 'demo'

export const EVO_PROFILES: Record<EvoProfile, {
  label: string
  screenFailed: number
  screenGuards: number
  /** Screen repetitions per slot. null → the built-in SCREEN_REPEATS. */
  screenRepeats: number | null
  gateTaskIds: string[] | null
  gateRepeats: number | null
}> = {
  full: { label: 'Full measurement', screenFailed: 6, screenGuards: 3, screenRepeats: null, gateTaskIds: null, gateRepeats: null },
  demo: { label: 'Demo (fast: 4 screened ×1 · 3 gate ×1)', screenFailed: 3, screenGuards: 1, screenRepeats: 1, gateTaskIds: ['G11', 'L12', 'S6'], gateRepeats: 1 },
}

/**
 * Held-out tasks never run, in any profile.
 *
 * G10「三对比文件特征对应矩阵」averages 115s per model call against a 120s
 * timeout — 29 runs, 12 failures, and it is the only task in the whole set that
 * ever failed. It is also one of the 13 tasks that sit at 0/3 on both sides of
 * every comparison, so it never carried signal either. Dropping it costs one
 * task of general-domain coverage and removes the only source of hard failures.
 *
 * S4 is the same kind of dead weight without the excuse of being slow: 0 passes
 * in 26 real runs. Every comparison it takes part in contributes a guaranteed
 * non-pass to both sides, so it inflates the denominator with a number that can
 * never move. It cannot rescue a candidate and it cannot regress one — it just
 * spends 20% of the gate budget on a constant.
 */
export const GATE_TASK_EXCLUDED: string[] = ['G10', 'S4']

/** Gate tasks for a profile, after the permanent exclusions. */
export function gateTasksFor(profile: EvoProfile): string[] | null {
  const spec = EVO_PROFILES[profile].gateTaskIds
  return spec ? spec.filter((id) => !GATE_TASK_EXCLUDED.includes(id)) : null
}

/**
 * Screening tasks that are never re-run, in any profile.
 *
 * L7「说明书公开充分性的判断」is the slowest task in the whole eval set: 194.7s
 * average, 536s worst case, 91.3k input tokens — and 0% pass over 6 real runs.
 * It sits in the repair split, so the "most recent failed tasks, newest first"
 * screen could pull a 3-minute dead end into any falsification pass, which then
 * returns "rescued 0" no matter what the candidate changed. It appears in
 * neither existing failure cluster, so dropping it costs the demo nothing.
 *
 * L8/L9/L10/L4/L11 are equally slow and equally at 0%, but they are the current
 * weak-grounding card's actual targets — they stay, otherwise there is nothing
 * to demonstrate.
 */
export const SCREEN_TASK_EXCLUDED: string[] = ['L7']
export type CardStatus = 'proposed' | 'screening' | 'applied' | 'falsified' | 'rejected'
export type CardVerdict = 'pending' | 'accepted' | 'falsified' | 'needs-human'

/** A deterministic failure cluster (design §7.2①). */
export interface EvoCluster {
  clusterId: string
  createdAt: string
  tag: MastTag
  /** The actionable harness gap the tag maps to (a closed seam key). */
  seam: string
  /** Primary failure tag × critical step × missing capability grouping key. */
  key: string
  count: number
  domain: PgDomain | 'mixed'
  criticalSteps: number[]
  summary: string
  runIds: string[]
  taskIds: string[]
  /** Edit-surface routing history (dynamic upgrade trail), newest last. */
  routeHistory: Array<{ surface: EvoSurface; reason: string; at: string }>
  status: 'open' | 'resolved' | 'archived'
}

/** A candidate config change produced by the LLM inside one routed surface. */
export interface ChangeCard {
  cardId: string
  clusterId: string
  createdAt: string
  surface: EvoSurface
  seam: string
  title: string
  nl: string
  /** prompt-surface content: guides text / checklist wording. */
  promptDiff: { guides?: string; guideStyle?: string } | null
  /** middleware-surface content: validated DSL field → value. */
  middlewareDiff: Partial<HarnessConfig> | null
  /** Playground-mount content (authority-mcp lives in PgMounts, not the DSL). */
  mountDiff: Partial<PgMounts> | null
  surfaceReason: string
  /** Inside the closed seam→surface set (true) or a new combination (false). */
  inTable: boolean
  /** Deterministic pre-apply estimate, before re-runs. */
  predictedGainPp: number | null
  /** Whether the seam is a security/legal hard gate (never auto-apply). */
  hardGate: boolean
  status: CardStatus
  verdict: CardVerdict
  /** LLM traceability: the exact proposal prompt and raw model output. */
  llmPrompt: string | null
  llmOutput: string | null
  proposalSource: 'llm' | 'template'
  /**
   * The real re-run result, kept on the card whether it passed or failed. A
   * failed screening is the most interesting outcome there is; dropping it left
   * the panel showing nothing but a "falsified" badge.
   */
  falsification: FalsificationResult | null
}

/** Paired falsification result from real re-runs (design §7.2④). */
export interface FalsificationResult {
  /** Tasks the baseline failed but the candidate rescued. */
  rescued: string[]
  /** Tasks that passed before and regressed after (must be zero to accept). */
  regressed: string[]
  /** Tasks that failed both. */
  stillFailed: string[]
  screened: number
  netLiftPp: number | null
  /** Bootstrap lower-bound paired relative lift (null when n too small). */
  relLift95: number | null
  /** Re-run costs. */
  avgTokens: number | null
  avgLatencyMs: number | null
  /** L3 mean USD cost over candidate re-runs; null when unpriced. */
  avgCostUsd: number | null
  /** Any security/legal hard gate that regressed (immediate falsification). */
  hardGateRegressed: boolean
  /**
   * Tasks whose pair flipped one way and then failed to reproduce it. A single
   * flipped sample is a coin flip, not a finding, so these are recorded and
   * counted as neither a rescue nor a regression.
   */
  unstable: string[]
  /**
   * Deterministic-check regressions: the parent's answer was clean on the leak /
   * injection / statute check and the candidate's is not. Kept apart from
   * `regressed` because it fires while BOTH halves miss the reading — the pair
   * then reads as "still failed" and a leaked ID number goes unseen.
   */
  hardRegressions: { taskId: string; reason: string }[]
  /** New run ids produced by the screening. */
  newRunIds: string[]
  /**
   * When this screening finished (ISO). A card can be re-screened after every
   * fix and the numbers come back in the same shape, so without a stamp a stored
   * result cannot be told apart from the one it replaced. Absent on results that
   * were stored before this field existed.
   */
  at?: string
  /**
   * Paired repetitions per screened task, as the profile ran them. The panel
   * reads it to describe the sample instead of assuming the built-in default.
   * Absent on results stored before this field existed.
   */
  screenRepeats?: number
  /**
   * Tasks whose re-run never produced an answer (provider/network error, budget
   * cutoff). They carry no signal at all, so they are excluded from rescued /
   * regressed / stillFailed rather than counted as failures — a screening pass
   * that hit this is indeterminate and must not judge the card.
   */
  incomplete: string[]
}

/**
 * §7.2④ gate full verification: the held-out 15-task gate set re-run under
 * both the parent and the candidate generation (paired). Never seen by
 * clustering or by the card proposal (kept scorecard-clean).
 */
export interface GateResult {
  gateTaskIds: string[]
  /**
   * Set instead of the numbers when the pass could not produce a verdict (some
   * gate run never produced an answer). The panel shows this rather than a
   * meaningless zero lift.
   */
  error?: string
  baselinePass: number
  candidatePass: number
  baselinePassPp: number
  candidatePassPp: number
  gateLiftPp: number
  /** Baseline pass → candidate fail (unique task ids that regressed at least once). */
  regressed: string[]
  /** Baseline fail → candidate pass (unique task ids). */
  fixed: string[]
  /** Tasks whose flip did not reproduce across repeats — no signal either way. */
  unstable?: string[]
  /** Deterministic-check regressions inside the gate (same rule as the screen). */
  hardRegressions?: { taskId: string; reason: string }[]
  avgTokens: number | null
  avgLatencyMs: number | null
  /** L3 mean USD cost over candidate gate runs; null when unpriced. */
  avgCostUsd: number | null
  /**
   * Per (task × config) repeat count (design §3.2). Sample size = gate tasks × repeats.
   * temperature>0 defaults to 3; temperature=0 defaults to 1.
   */
  repeats: number
  baselineRunIds: string[]
  newRunIds: string[]
  ranAt: string
}

export type GateStatus = 'idle' | 'running' | 'passed' | 'failed'

/** An immutable config generation created by applying a card. */
export interface EvoGeneration {
  generationId: string
  parentId: string | null
  label: string
  fingerprint: string
  config: HarnessConfig
  mounts: PgMounts
  createdAt: string
  source: 'base' | 'evolve'
  cardId: string | null
}

/** A committed change (applied card → new generation) plus its falsification. */
export interface EvoMutation {
  commitId: string
  cardId: string
  clusterId: string
  parentGenerationId: string
  generationId: string
  createdAt: string
  configDiff: Partial<HarnessConfig>
  approvedBy: 'gate' | 'human'
  autonomyLevel: number
  falsification: FalsificationResult
  /** §7.2④ held-out gate full verification (filled lazily on demand). */
  gate?: GateResult | null
  gateStatus?: GateStatus
}

export interface EvoAnalysis {
  clusters: EvoCluster[]
  cards: ChangeCard[]
  note: string | null
}

export interface AutoJob {
  running: boolean
  phase: string
  generationsApplied: number
  stopReason: string | null
  lastError: string | null
  updatedAt: string
  /**
   * Process epoch these detached jobs belong to. A background job lives inside
   * the server process, so a restart leaves a stale `running: true` row that
   * would make the UI poll forever; comparing epoch exposes that as "interrupted".
   */
  bootId?: string
}

/**
 * §7.2④ side-by-side race: one candidate's row in the top-N comparison. The
 * race is what "Pareto 跨多候选择优" actually means — several cards are run
 * through the same held-out gate pass and compared on (success ↑, cost ↓).
 * Losers are recorded, not silently dropped, so the pick is auditable.
 */
export interface EvoRaceEntry {
  cardId: string
  title: string
  surface: EvoSurface
  seam: string
  /** Why this card left the race; null when it reached the Pareto pick. */
  dropped: string | null
  baselinePassPp: number
  candidatePassPp: number
  gateLiftPp: number
  regressed: number
  fixed: number
  avgTokens: number | null
  /** L3 mean USD cost over its gate runs; null when the model is unpriced. */
  avgCostUsd: number | null
  /** Which axis the Pareto comparison used: real USD, token proxy, or none. */
  costAxis: 'usd' | 'token' | 'none'
  /** Resolved cost on `costAxis` (0 when there is no cost signal at all). */
  cost: number
  /** Sits on the (success ↑, cost ↓) frontier. */
  onFrontier: boolean
}

export interface EvoRace {
  raceId: string
  at: string
  /** How many cards were allowed into the race. */
  topN: number
  /** §3.2 repeats per (task × config) in the gate pass. */
  repeats: number
  /** Cards that survived the repair screen. */
  screened: number
  /** Cards that actually reached the gate pass. */
  gated: number
  entries: EvoRaceEntry[]
  winnerCardId: string | null
  /**
   * The winner was picked but cannot be applied without a human: slider 0, or
   * the winning card is out-of-table / a security-legal hard gate (§7.5).
   */
  awaitingHuman: boolean
  applied: boolean
  note: string | null
}

export interface EvoRaceJob {
  running: boolean
  phase: string
  race: EvoRace | null
  lastError: string | null
  updatedAt: string
  /** See AutoJob.bootId — a stale `running` row means the process restarted. */
  bootId?: string
}

export interface EvoState {
  clusters: EvoCluster[]
  cards: ChangeCard[]
  generations: EvoGeneration[]
  mutations: EvoMutation[]
  currentGenerationId: string | null
  autoJob?: AutoJob | null
  raceJob?: EvoRaceJob | null
}

export interface ApplyResult {
  ok: boolean
  card?: ChangeCard
  falsification?: FalsificationResult | null
  generation?: EvoGeneration | null
  mutation?: EvoMutation | null
  approvedBy?: 'gate' | 'human' | null
  started?: boolean
  error?: string
}
