// F6 Security Red-Team Chamber — canonical security vocabulary (PRD §F6).
// Previously: "可控七件套" collided with F5 "垂直七件套"; kill-chain stages
// had long (Privilege Escalation/Action Execution) vs short (Escalation/
// Action) parallel names; APASS EXECUTE/ASK/REFUSE was mixed with hook
// verdicts (allow/deny/rewrite) and human verdicts (Approve/Modify/Reject).

// Canonical: Security Controls (7). Never call them bare "七件套".
export const SECURITY_CONTROLS = [
  'input-isolation',
  'tool-boundary-gateway',
  'least-privilege-creds',
  'exec-sandbox',
  'human-approval-gate',
  'egress-dlp',
  'outofband-killswitch',
] as const
export type SecurityControl = (typeof SECURITY_CONTROLS)[number]
export const SECURITY_CONTROL_LABEL: Record<SecurityControl, string> = {
  'input-isolation': 'Input Source Isolation',
  'tool-boundary-gateway': 'Tool Boundary Gateway',
  'least-privilege-creds': 'Least Privilege & Ephemeral Credentials',
  'exec-sandbox': 'Execution Sandbox',
  'human-approval-gate': 'Human Approval Gate',
  'egress-dlp': 'Egress DLP',
  'outofband-killswitch': 'Out-of-Band Kill-Switch & Attestation',
}

// Canonical: Kill-Chain stages (5). Long names canonical; short names alias.
export const KILL_CHAIN = [
  'ingress',
  'lurk',
  'privilege-escalation',
  'action-execution',
  'exfiltration',
] as const
export type KillChainStage = (typeof KILL_CHAIN)[number]
export const KILL_CHAIN_LABEL: Record<KillChainStage, string> = {
  ingress: 'Ingress',
  lurk: 'Lurk',
  'privilege-escalation': 'Privilege Escalation',
  'action-execution': 'Action Execution',
  exfiltration: 'Exfiltration',
}
export const KILL_CHAIN_ALIAS: Record<string, KillChainStage> = {
  Escalation: 'privilege-escalation',
  Action: 'action-execution',
  进入: 'ingress',
  潜伏: 'lurk',
  提权: 'privilege-escalation',
  动作: 'action-execution',
  外发: 'exfiltration',
}

// APASS runtime router tri-state (export artifact, F6-3). Distinct from hook
// verdicts (allow/deny/rewrite) and human verdicts (Approve/Modify/Reject).
export const APASS_ROUTER = ['EXECUTE', 'ASK', 'REFUSE'] as const
export type ApassRoute = (typeof APASS_ROUTER)[number]

export const HONESTY_NOTE =
  'Tested ≠ absolutely secure. Policy still needs runtime monitoring and case reflux.'

// ---------- F6 fixture shapes ----------

export type KillStatus = 'blocked' | 'breached'

export interface KillStage {
  stage: KillChainStage
  status: KillStatus
  note: string
}

export interface AttackCase {
  id: string
  title: string
  tactic: string
  /** Classification source, e.g. OWASP Agentic Top10 / AgentDojo / AgentRedBench. */
  mapping: string
  stages: KillStage[]
  /** Tools / data reachable at the deepest breach (blast radius). */
  blastRadius: string[]
}

export interface ControlPoint {
  id: string
  label: string
  controls: SecurityControl[]
  /** Attack success rate %, lower is better. */
  asr: number
  /** Task utility %, higher is better. */
  utility: number
  /** Human interruptions / delay index 0–100, lower is better. */
  friction: number
}

export interface ControlStory {
  id: string
  text: string
  point: string
}

export interface RedteamBundle {
  attacks: AttackCase[]
  controls: {
    points: ControlPoint[]
    stories: ControlStory[]
    references: { name: string; value: string; citation: string }[]
    source: { kind: string; label: string; citation?: string }[]
  }
}
