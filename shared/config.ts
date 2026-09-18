// 20-field Harness Configuration DSL, mapped 1:1 to standard modules.
export interface HarnessConfig {
  // Runtime Core
  loopControl: 'basic' | 'plan-act' | 'reflexion'
  toolset: 'minimal' | 'standard' | 'extended'
  filesystem: 'none' | 'file-backed-state'
  sandbox: 'off' | 'readonly-parallel' | 'write-barrier'
  subAgents: 'off' | 'context-isolated'
  // State & Memory
  planner: 'off' | 'todo-list'
  memory: 'none' | 'flat' | 'layered'
  compression: 'off' | 'budget' | 'five-layer'
  skills: 'off' | 'progressive-disclosure'
  // Constraints & Safety
  hooks: 'off' | 'lifecycle'
  permissions: 'open' | 'ask-write' | 'deny-first'
  guides: 'none' | 'style-rules' | 'domain-checklist'
  sensors: 'none' | 'lint' | 'verifier' | 'verifier+critic'
  selfVerify: 'off' | 'premature-victory-check'
  globalPolicy: 'none' | 'policy-enforced'
  // Evolution & Resilience
  observability: 'off' | 'trace' | 'trace+mast'
  eval: 'off' | 'golden-set'
  humanInLoop: 'none' | 'approval-gates' | 'slider'
  resume: 'off' | 'checkpoint'
  optimizer: 'off' | 'wind-tunnel-search'
}

export type ConfigField = keyof HarnessConfig

export const CONFIG_FIELDS = Object.keys({
  loopControl: 1, toolset: 1, filesystem: 1, sandbox: 1, subAgents: 1,
  planner: 1, memory: 1, compression: 1, skills: 1,
  hooks: 1, permissions: 1, guides: 1, sensors: 1, selfVerify: 1, globalPolicy: 1,
  observability: 1, eval: 1, humanInLoop: 1, resume: 1, optimizer: 1,
} satisfies Record<ConfigField, 1>) as ConfigField[]

export const COMPONENT_GROUPS: { group: string; fields: ConfigField[] }[] = [
  { group: 'Runtime Core', fields: ['loopControl', 'toolset', 'filesystem', 'sandbox', 'subAgents'] },
  { group: 'State & Memory', fields: ['planner', 'memory', 'compression', 'skills'] },
  { group: 'Constraints & Safety', fields: ['hooks', 'permissions', 'guides', 'sensors', 'selfVerify', 'globalPolicy'] },
  { group: 'Evolution & Resilience', fields: ['observability', 'eval', 'humanInLoop', 'resume', 'optimizer'] },
]

export const COMPONENT_META: Record<ConfigField, { label: string; options: { value: string; label: string }[]; evidence?: string; enforced?: boolean }> = {
  loopControl: { label: '① Loop Control Flow', options: [{ value: 'basic', label: 'basic' }, { value: 'plan-act', label: 'plan-act' }, { value: 'reflexion', label: 'reflexion' }], evidence: 'Plan/Act separation is the industry convergent pattern' },
  toolset: { label: '② Tool Surface', options: [{ value: 'minimal', label: 'minimal' }, { value: 'standard', label: 'standard' }, { value: 'extended', label: 'extended' }], evidence: 'Restrict tool surface by operational mode' },
  filesystem: { label: '③ File System & State', options: [{ value: 'none', label: 'none' }, { value: 'file-backed-state', label: 'file-backed-state' }], evidence: 'NLAH v2: +2.6 / +13.9pp, strongest cross-app gain' },
  sandbox: { label: '④ Execution Sandbox', options: [{ value: 'off', label: 'off' }, { value: 'readonly-parallel', label: 'readonly-parallel' }, { value: 'write-barrier', label: 'write-barrier' }], evidence: 'dsh: fail-closed, read-only parallel execution with write barriers', enforced: true },
  subAgents: { label: '⑤ Sub-Agent Isolation', options: [{ value: 'off', label: 'off' }, { value: 'context-isolated', label: 'context-isolated' }], evidence: 'Cognition: spawn sub-agents strictly for context isolation' },
  planner: { label: '⑥ Task Planner', options: [{ value: 'off', label: 'off' }, { value: 'todo-list', label: 'todo-list' }] },
  memory: { label: '⑦ Memory Hierarchy', options: [{ value: 'none', label: 'none' }, { value: 'flat', label: 'flat' }, { value: 'layered', label: 'layered' }], evidence: 'MemGPT/CoALA: paged hierarchical memory architecture' },
  compression: { label: '⑧ Context Compression', options: [{ value: 'off', label: 'off' }, { value: 'budget', label: 'budget' }, { value: 'five-layer', label: 'five-layer' }], evidence: 'Claude Code 5-stage shaper: cheap to expensive progressive cascade' },
  skills: { label: '⑨ Progressive Disclosure', options: [{ value: 'off', label: 'off' }, { value: 'progressive-disclosure', label: 'progressive-disclosure' }] },
  hooks: { label: '⑩ Lifecycle Hooks', options: [{ value: 'off', label: 'off' }, { value: 'lifecycle', label: 'lifecycle' }], evidence: 'Claude Code: ~30 deterministic lifecycle hooks' },
  permissions: { label: '⑪ Permission Gate', options: [{ value: 'open', label: 'open' }, { value: 'ask-write', label: 'ask-write' }, { value: 'deny-first', label: 'deny-first' }], evidence: 'deny-first is a deterministic gate; prompt guidance is only probabilistic', enforced: true },
  guides: { label: '⑫ Feedforward Guidelines', options: [{ value: 'none', label: 'none' }, { value: 'style-rules', label: 'style-rules' }, { value: 'domain-checklist', label: 'domain-checklist' }], evidence: 'Guides feed forward before action; probabilistic' },
  sensors: { label: '⑬ Feedback Sensors & Lints', options: [{ value: 'none', label: 'none' }, { value: 'lint', label: 'lint' }, { value: 'verifier', label: 'verifier' }, { value: 'verifier+critic', label: 'verifier+critic' }], evidence: 'NLAH v2: SWE +0.2pp, OSWorld +8.4pp (revised positive when kept close to the acceptance gate)', enforced: true },
  selfVerify: { label: '⑭ Self-Verification Circuit', options: [{ value: 'off', label: 'off' }, { value: 'premature-victory-check', label: 'premature-victory check' }] },
  globalPolicy: { label: '⑮ Global Safety Policy', options: [{ value: 'none', label: 'none' }, { value: 'policy-enforced', label: 'policy-enforced' }] },
  observability: { label: '⑯ Observability & Trace', options: [{ value: 'off', label: 'off' }, { value: 'trace', label: 'trace' }, { value: 'trace+mast', label: 'trace+mast annotation' }] },
  eval: { label: '⑰ Golden Evaluation Set', options: [{ value: 'off', label: 'off' }, { value: 'golden-set', label: 'golden-set' }] },
  humanInLoop: { label: '⑱ Human-in-the-Loop Gate', options: [{ value: 'none', label: 'none' }, { value: 'approval-gates', label: 'approval-gates' }, { value: 'slider', label: 'autonomy-slider' }] },
  resume: { label: '⑲ Checkpoint & Resume', options: [{ value: 'off', label: 'off' }, { value: 'checkpoint', label: 'checkpoint' }] },
  optimizer: { label: '⑳ Optimizer', options: [{ value: 'off', label: 'off' }, { value: 'wind-tunnel-search', label: 'wind-tunnel-search' }], evidence: 'NLAH v2: Self-Evolution yields +5.8pp gain on SWE benchmark' },
}

export const BASE_CONFIG: HarnessConfig = {
  loopControl: 'basic', toolset: 'minimal', filesystem: 'none', sandbox: 'off', subAgents: 'off',
  planner: 'off', memory: 'none', compression: 'off', skills: 'off',
  hooks: 'off', permissions: 'open', guides: 'none', sensors: 'none', selfVerify: 'off', globalPolicy: 'none',
  observability: 'off', eval: 'off', humanInLoop: 'none', resume: 'off', optimizer: 'off',
}

export function cfg(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  return { ...BASE_CONFIG, ...overrides }
}

export function fingerprint(c: HarnessConfig): string {
  const s = CONFIG_FIELDS.map((k) => `${k}=${c[k]}`).join('|')
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

export function configDistance(a: HarnessConfig, b: HarnessConfig): number {
  return CONFIG_FIELDS.reduce((n, k) => (a[k] === b[k] ? n : n + 1), 0)
}

export function configDiff(a: HarnessConfig, b: HarnessConfig): Partial<Record<ConfigField, [string, string]>> {
  const out: Partial<Record<ConfigField, [string, string]>> = {}
  for (const k of CONFIG_FIELDS) if (a[k] !== b[k]) out[k] = [a[k], b[k]]
  return out
}
