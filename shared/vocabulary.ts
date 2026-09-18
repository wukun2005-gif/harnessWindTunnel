// Canonical vocabulary for HarnessWindTunnel.
// PRD v1.1 integrates NLAH / AHE / Harness-R1 / Airbnb PRISM / MAST / L-MARS /
// Claude Code / docStudio / APASS papers & products. Each source ships its own
// nouns; this file is the single canonical layer. Paper-native aliases are
// listed as aliases only and must not leak as parallel UI terms.
//
// Convention: UI displays CANONICAL English. Chinese appears only in code
// comments / PRD prose. Aliases are accepted on import, never emitted.

// ─── App modes & screens: 3 modes × 3 screens (PRD §1.3, ADR-01) ───
// Mode names were scattered as 通用风洞/General Wind Tunnel/HarnessWindTunnel,
// 领域风洞/Domain Wind Tunnel, 安全红队舱/Red-Team Chamber. Canonical below.
export const MODES = ['general', 'legal', 'security'] as const
export type Mode = (typeof MODES)[number]
export const MODE_LABEL: Record<Mode, string> = {
  general: 'General Wind Tunnel',
  legal: 'Legal Domain Wind Tunnel',
  security: 'Security Red-Team Chamber',
}
// Alias: PRD short-hands. Do not display.
export const MODE_ALIAS: Record<string, Mode> = {
  HarnessWindTunnel: 'general',
  'Domain Wind Tunnel': 'legal',
  'Red-Team Chamber': 'security',
  'RedTeam Chamber': 'security',
}

// Screens: one motherboard, three projections (PRD §4 F1-F3, §F5/F6 mirror).
// Domain mirrors must reuse these names, never invent parallel ones:
//   legal Screen-1 = Case Review (a projection of insight)
//   legal Screen-3 = Compliance Evolution (a projection of evolution)
//   security Screen-1 = Kill-Chain Attack Flow (a projection of insight)
//   security Screen-2 = Controls Ablation (a projection of Wind Tunnel)
//   security Screen-3 = Policy Synthesis (a projection of evolution)
export const SCREENS = ['mri', 'tunnel', 'forge'] as const
export type Screen = (typeof SCREENS)[number]
export const SCREEN_LABEL: Record<Screen, string> = {
  mri: 'Run Insight',
  tunnel: 'Wind Tunnel',
  forge: 'Evolution',
}
export const SCREEN_PROJECTION: Record<string, string> = {
  'Case Review': 'mri',
  'Kill-Chain': 'mri',
  'Controls Ablation': 'tunnel',
  'Audit Staircase': 'tunnel',
  'Compliance Forge': 'forge',
  'Policy Synthesis': 'forge',
}

// ─── Enforcement dichotomy (PRD §1.4) ───
// Papers say: deterministic gate / wrapper ENFORCE vs probabilistic prompt /
// guide REQUEST vs 硬强制/软引导. Canonical pair below; all UI uses it.
export const ENFORCEMENT = ['enforced', 'guide'] as const
export type Enforcement = (typeof ENFORCEMENT)[number]
export const ENFORCEMENT_LABEL: Record<Enforcement, string> = {
  enforced: 'Enforced · Deterministic Wrapper',
  guide: 'Guide · Probabilistic Prompt',
}
export const ENFORCEMENT_ALIAS: Record<string, Enforcement> = {
  'Hard-enforced': 'enforced',
  wrapper: 'enforced',
  ENFORCE: 'enforced',
  'Soft Guide': 'guide',
  REQUEST: 'guide',
  Probabilistic: 'guide',
}
// PRD §1.4: enforced modules are Sandbox(④), Permissions(⑪), Sensors(⑬).
export const ENFORCED_FIELDS = ['sandbox', 'permissions', 'sensors'] as const

// ─── Compression mode vs Shaper stage (PRD §1.3 ⑧ vs §F1-5) ───
// "budget" was overloaded: compression mode `budget` AND shaper stage-1
// `Budget`. They are distinct levels: mode selects the pipeline, stage is a
// step inside the five-layer pipeline. Never display bare "budget".
export const COMPRESSION_LABEL = 'Context Compression Mode' as const
export const SHAPER_LABEL_CANONICAL = '5-Stage Shaper Cascade' as const

// ─── Intervention markers (PRD §4.4 canonical long names) ───
// Code previously used short forms (Hook/Shaper/Compaction/Fork/Join/
// Failure Tag). Canonical long forms below; short forms are aliases.
export const INTERVENTION_LABEL = {
  hook: 'Hook Intercept',
  permission: 'Permission Gate',
  shaper: 'Shaper Fired',
  verifierReject: 'Verifier Rejected',
  verifierPass: 'Verifier Passed',
  lintReject: 'Lint Rejected',
  lintPass: 'Lint Passed',
  fork: 'Agent Fork',
  join: 'Agent Join',
  compact: 'Compaction Boundary',
  failureTag: 'MAST Failure Tag',
  criticalStep: 'Critical Failure Step',
  optimizer: 'Optimizer',
} as const

// ─── Change artifact (F3-2): canonical is "Change Card" ───
// Code had parallel "Modification Card" (forge.card.title) vs "Change Card"
// (forge.change.card, demo.*). Canonical: Change Card. Modification is alias.
export const CHANGE_CARD_LABEL = 'Change Card' as const
export const CHANGE_CARD_ALIAS = ['Modification Card', '改动卡'] as const

// ─── Human verdict tri-state (F3-4): Approve / Modify / Reject ───
// Code Forge store/UI only offered Approve/Reject (Modify missing). Canonical
// keeps all three; UI without Modify must label itself as 2-state subset.
export const HUMAN_VERDICT = ['approve', 'modify', 'reject'] as const
export type HumanVerdict = (typeof HUMAN_VERDICT)[number]
export const HUMAN_VERDICT_LABEL: Record<HumanVerdict, string> = {
  approve: 'Approve',
  modify: 'Modify',
  reject: 'Reject',
}

// ─── Gates: four distinct gates, never collapse into one "gate" noun ───
// ⑪ Permission Gate (runtime) · ⑱ Human-in-the-Loop Gate (evolution entry) ·
// Forge Approval Gate (per-card decision) · F5 Release/Risk gates (legal) ·
// F6 Tool Boundary Gateway + APASS Router (runtime export). See redteam.ts.
export const GATE_KINDS = [
  'permission-gate',
  'hitl-gate',
  'approval-gate',
  'release-gate',
  'risk-gate',
  'tool-boundary-gateway',
  'apass-router',
] as const

// ─── Datasets (PRD §5.3): repair / gate / scorecard ───
// "Holdout/留出" is an alias of scorecard, not a fourth set.
export const DATASETS = ['repair', 'gate', 'scorecard'] as const
export type DatasetSplit = (typeof DATASETS)[number]
export const DATASET_ALIAS: Record<string, DatasetSplit> = {
  holdout: 'scorecard',
  留出: 'scorecard',
  修复集: 'repair',
  筛选集: 'gate',
}

// ─── Sources: 4 kinds + nearest-neighbor fallback state (PRD §F4, NFR) ───
// Code had fixture|paper-reproduction|live; PRD F4-5 adds imported/live.
// Fallback "Approximate/Simulated·Nearest Neighbor/示意/脚本复现" is not a
// kind — it is exactMatch=false rendering of a fixture read.
export const SOURCES = ['fixture', 'paper-reproduction', 'live', 'imported'] as const
export type SourceKindCanonical = (typeof SOURCES)[number]
export const SOURCE_LABEL: Record<SourceKindCanonical, string> = {
  fixture: 'Offline Fixture',
  'paper-reproduction': 'Paper Reproduction',
  live: 'Live Evaluation',
  imported: 'Imported Trajectory',
}

// ─── Baseline (PRD §1.2): canonical "Bare Baseline" ───
// Aliases Basic/Baseline/base all mean BASE_CONFIG. Preset "Basic" kept as
// display alias only where paper citation requires it.
export const BASELINE_LABEL = 'Bare Baseline' as const
export const BASELINE_ALIAS = ['Basic', 'Baseline', 'base', '裸基准'] as const

// ─── Optimizer (module ⑳): canonical "Optimizer" ───
// "Self-Evolution" is the NLAH paper nickname for its gain (+5.8pp v2), not a
// second module. UI shows Optimizer; Self-Evolution appears only inside the
// NLAH evidence string / branch nickname.
export const OPTIMIZER_LABEL = 'Optimizer' as const
export const OPTIMIZER_ALIAS = ['Self-Evolution', 'wind-tunnel-search', '自演化'] as const
