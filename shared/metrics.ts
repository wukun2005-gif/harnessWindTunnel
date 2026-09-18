// Canonical metric & dataset definitions (PRD §5.3, dev-plan §3.3-3.5).
// Previously: Holdout/留出/scorecard used as three names for two sets;
// Lift / Skill Lift / Model-Conditional Lift mixed without a home;
// WorstLift vs RelLift95 selection rule lived only in prose.

export const METRIC_DEFS = {
  lift: 'Candidate minus baseline on the unseen scorecard split.',
  meanLift: 'Mean of per-run Lift.',
  maxLift: 'Best per-run Lift.',
  worstLift: 'Worst per-run Lift (may be negative; never hidden).',
  rr0: 'Share of runs with Lift > 0.',
  relLift95:
    '5th percentile of the bootstrapped (5000x) mean-Lift distribution: conservative net gain under bad luck.',
  skillLift: 'Paired Lift with exactly one config field changed (configDistance = 1).',
  modelConditionalLift: 'score(harness, model) minus score(bare baseline, model) on scorecard.',
  compatibilitySpread: 'Max-minus-min and std of one harness across models.',
  rankRobustness: 'Kendall tau between model ranking under harness vs bare baseline.',
  crossModelWorstLift: 'Worst Model-Conditional Lift across models.',
} as const
export type MetricName = keyof typeof METRIC_DEFS

// Decision rule (PRD §5.3): both shown; WorstLift is the default sort key when
// candidates are fully tested, RelLift95 is the aid under tight run budgets.
export const METRIC_DEFAULT_SORT = 'worstLift' as const

export const DATASET_SPLITS = ['repair', 'gate', 'scorecard'] as const
export type DatasetSplit = (typeof DATASET_SPLITS)[number]
export const DATASET_LABEL: Record<DatasetSplit, string> = {
  repair: 'Repair split (fit change cards only)',
  gate: 'Gate split (select among candidates)',
  scorecard: 'Scorecard split (final scoring only, unseen during tuning)',
}
