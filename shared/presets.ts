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

// Four paper reproduction presets. Baseline numbers are script fixtures; delta figures cite literature.
export const PRESETS: Preset[] = [
  {
    id: 'nlah-ablation',
    title: 'NLAH Controlled Ablation',
    tagline: 'Same runtime, same model, one module added at a time',
    scenarioId: 'workflow-crm-export',
    source: { kind: 'paper-reproduction', label: 'Paper reproduction · script', citation: 'Natural-Language Agent Harnesses, arXiv:2603.25723' },
    reading: 'File-backed State (key scope written to a file first) is positive across both task families — code repair (SWE-bench) and cross-app desktop tasks (paper calls them OSWorld) — (+1.6/+5.5pp); Verifier (auto-check before finishing) alone on cross-app tasks drops −8.4pp (loop self-inflates), but with File-backed State pre-locking scope, Verifier passes first try (+0.8pp). Modules interact — more do not always equal better.',
    variants: [
      { label: 'Basic', config: cfg(), branchId: 'base', note: 'Baseline (illustrative) 46.2%' },
      { label: '+ Verifier', config: cfg({ permissions: 'ask-write', sensors: 'verifier' }), branchId: 'verifier', note: 'Δ −8.4pp → 37.8% · verifier = auto-check before finishing; OSWorld = paper’s name for cross-app desktop tasks' },
      { label: '+ File-backed State', config: cfg({ filesystem: 'file-backed-state' }), branchId: 'filestate', note: 'Δ +5.5pp → 51.7% · file-backed state = key scope written to a file first' },
      { label: '+ Isolated Sub-Agents × Critic Pick (paper: Multi-Candidate)', config: cfg({ sensors: 'verifier+critic', subAgents: 'context-isolated' }), branchId: 'multicand', note: 'Δ −3.1pp → 43.1% · ⑤ sub-agents → context-isolated + ⑬ sensors → verifier+critic; paper bundles this pair as Multi-Candidate; negative on both families (code repair + cross-app)' },
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
]
