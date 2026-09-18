import { cfg, type HarnessConfig } from './config'
import type { SourceRef } from './events'

export interface PresetVariant {
  label: string
  config: HarnessConfig
  branchId?: string
  note?: string
}

export interface Preset {
  id: string
  title: string
  tagline: string
  scenarioId: string
  source: SourceRef
  variants: PresetVariant[]
  reading: string
}

// Three paper-reproduction presets plus one fixture pair preset (F2-10). Baseline numbers are script fixtures; delta figures cite literature.
export const PRESETS: Preset[] = [
  {
    id: 'nlah-ablation',
    title: 'NLAH Controlled Ablation',
    tagline: 'Same runtime, same model, one module added at a time',
    scenarioId: 'workflow-crm-export',
    source: { kind: 'paper-reproduction', label: 'Paper reproduction · script', citation: 'Natural-Language Agent Harnesses, arXiv:2603.25723v2 (Table 5)' },
    reading: 'File-backed State is the strongest cross-app gain (+13.9pp); Verifier revised positive in v2 (+8.4pp on cross-app tasks when kept close to the acceptance gate); aggressive compression backfires (−8.3pp) when summaries drift from the evaluator; multi-candidate adds branching for a small gain (+2.8pp) but stays negative on code repair (−1.6pp). Tighter acceptance paths win — more structure does not always equal better.',
    variants: [
      { label: 'Basic', config: cfg(), branchId: 'base', note: 'Baseline (illustrative) 44.4%' },
      { label: '+ File-backed State', config: cfg({ filesystem: 'file-backed-state' }), branchId: 'filestate', note: 'Δ +13.9pp → 58.3% · file-backed state = key scope written to a file first' },
      { label: '+ Verifier', config: cfg({ permissions: 'ask-write', sensors: 'verifier' }), branchId: 'verifier', note: 'Δ +8.4pp → 52.8% · verifier = auto-check before finishing; v2 revision: positive on cross-app tasks' },
      { label: '+ Budget-only Compression', config: cfg({ compression: 'budget' }), branchId: 'compress', note: 'Δ −8.3pp → 36.1% · aggressive summaries drift from the evaluator' },
      { label: '+ Isolated Sub-Agents × Critic Pick (paper: Multi-Candidate)', config: cfg({ sensors: 'verifier+critic', subAgents: 'context-isolated' }), branchId: 'multicand', note: 'Δ +2.8pp → 47.2% · small gain on cross-app, −1.6pp on code repair; branching ≠ control' },
    ],
  },
  {
    id: 'ahe-ten-gen',
    title: 'AHE Ten-Generation Evolution',
    tagline: '10 rounds of evaluate→analyze→improve, Terminal-Bench2 69.7% → 77.0%',
    scenarioId: 'coding-terminal-refactor',
    source: { kind: 'paper-reproduction', label: 'Paper reproduction · script', citation: 'Agentic Harness Engineering, arXiv:2604.25850' },
    reading: 'Generations 9 and 10 each had regression candidates caught by the wind tunnel — progression is non-linear.',
    variants: [
      { label: 'Gen 0 (Start)', config: cfg({ toolset: 'standard', observability: 'trace' }), branchId: 'ahe-gen0', note: '69.7%' },
      {
        label: 'Gen 10 (End)',
        config: cfg({ loopControl: 'plan-act', toolset: 'standard', planner: 'todo-list', compression: 'five-layer', sensors: 'verifier', subAgents: 'context-isolated', observability: 'trace+mast' }),
        branchId: 'tuned', note: '77.0%',
      },
    ],
  },
  {
    id: 'harness-r1-regress',
    title: 'Harness-R1 Counter-Example',
    tagline: 'Strong model self-modifies harness: 21 of 39 patches regressed performance',
    scenarioId: 'coding-terminal-refactor',
    source: { kind: 'paper-reproduction', label: 'Paper reproduction · script', citation: 'Harness-R1, arXiv:2608.02276' },
    reading: '41.6% → 35.4% (-6.2pp): unverified auto-evolution without human gates is a liability.',
    variants: [
      { label: 'Baseline Batch', config: cfg({ toolset: 'standard', observability: 'trace', eval: 'golden-set' }), branchId: 'r1-batch', note: '41.6%' },
      { label: 'Naive Self-Patch', config: cfg({ toolset: 'standard', observability: 'trace', sensors: 'verifier+critic', loopControl: 'reflexion' }), branchId: 'r1-naive', note: '35.4% (-6.2pp)' },
    ],
  },
  {
    id: 'minimal-rich-pairs',
    title: 'Minimal vs Rich Pairs',
    tagline: 'Three single-variable pairs: tool surface, prompt length, compression reset',
    scenarioId: 'workflow-crm-export',
    source: { kind: 'fixture', label: 'Illustrative pairs (directions: Pi / Earendil, Ralph Loop, Databricks note)', citation: 'harness-research-v0.5 §4.5' },
    reading: 'Rich is not always better: 18+ tools paralyze (−3.5pp), long prompts stay near-neutral (+1.4pp), sustained compression beats per-round reset (+4.6pp).',
    variants: [
      { label: 'Minimal 4-tool (tool pair base)', config: cfg(), branchId: 'base', note: '44.4%' },
      { label: 'Rich 18+ tools', config: cfg({ toolset: 'extended' }), branchId: 'tools-rich', note: 'Δ −3.5pp → 40.9% · decision paralysis' },
      { label: 'Short prompt (prompt pair base)', config: cfg(), branchId: 'base', note: '44.4%' },
      { label: 'Long system prompt', config: cfg({ guides: 'style-rules' }), branchId: 'prompt-long', note: 'Δ +1.4pp → 45.8% · near-neutral' },
      { label: 'Per-round reset (compression pair base)', config: cfg(), branchId: 'base', note: '44.4%' },
      { label: 'Sustained five-layer', config: cfg({ compression: 'five-layer' }), branchId: 'sustain', note: 'Δ +4.6pp → 49.0% · Ralph Loop direction' },
    ],
  },
]
