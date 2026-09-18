// F5 Legal Domain Wind Tunnel — canonical domain vocabulary (PRD §F5).
// Previously: "垂直七件套" collided with F6 "可控七件套"; assertion labels
// were 4 (dev-plan §4.6) vs 5 (PRD F5-2 list) vs "六类" (PRD F5-2 prose).

// Canonical: Legal Controls (7). Never call them bare "七件套".
export const LEGAL_CONTROLS = [
  'authority-mcp',
  'citation-audit',
  'deadline-ledger',
  'jurisdiction-filter',
  'issue-close-gate',
  'risk-escalation-gate',
  'hash-audit-chain',
] as const
export type LegalControl = (typeof LEGAL_CONTROLS)[number]
export const LEGAL_CONTROL_LABEL: Record<LegalControl, string> = {
  'authority-mcp': 'Authority Library MCP Link',
  'citation-audit': 'Citation Fidelity Audit',
  'deadline-ledger': 'Deadline & Figure Reconciler',
  'jurisdiction-filter': 'Jurisdiction & Limitations Filter',
  'issue-close-gate': 'Issue-Closure Release Gate',
  'risk-escalation-gate': 'Risk-Tier Escalation Gate',
  'hash-audit-chain': 'Hash Audit Chain',
}
export const LEGAL_CONTROL_ENFORCEMENT: Record<LegalControl, 'enforced' | 'guide'> = {
  'authority-mcp': 'enforced',
  'citation-audit': 'guide',
  'deadline-ledger': 'enforced',
  'jurisdiction-filter': 'enforced',
  'issue-close-gate': 'enforced',
  'risk-escalation-gate': 'enforced',
  'hash-audit-chain': 'enforced',
}

// Canonical: L-MARS atomic assertion labels (5). PRD F5-2 prose "六类" is a
// count error: the listed set has 5 members. 4-label variant in dev-plan §4.6
// (missing no_citation) is superseded by this 5-label set.
export const LEGAL_ASSERTIONS = [
  'supported',
  'partially_supported',
  'unsupported',
  'citation_unreachable',
  'no_citation',
] as const
export type LegalAssertion = (typeof LEGAL_ASSERTIONS)[number]
export const LEGAL_ASSERTION_LABEL: Record<LegalAssertion, string> = {
  supported: 'Supported',
  partially_supported: 'Partially Supported',
  unsupported: 'Unsupported',
  citation_unreachable: 'Citation Unreachable',
  no_citation: 'No Citation',
}
// Legacy aliases found in PRD/code: partially, citation_unreachable short forms.
export const LEGAL_ASSERTION_ALIAS: Record<string, LegalAssertion> = {
  partially: 'partially_supported',
  'Partially Supported': 'partially_supported',
  citation_unreachable: 'citation_unreachable',
  'Citation Unreachable': 'citation_unreachable',
}

// ABA Formal Opinion 512 duties + China filing note (F5-4 license card).
export interface AbaDuty {
  rule: string
  en: string
  zh: string
  /** Legal controls that must all be enabled for this duty to read "covered". */
  gates: LegalControl[]
}
export const ABA_DUTIES: AbaDuty[] = [
  { rule: '1.1', en: 'Competence', zh: '胜任', gates: ['citation-audit', 'deadline-ledger', 'jurisdiction-filter'] },
  { rule: '1.6', en: 'Confidentiality', zh: '保密', gates: ['hash-audit-chain', 'risk-escalation-gate'] },
  { rule: '1.4', en: 'Communication', zh: '沟通', gates: ['issue-close-gate', 'risk-escalation-gate'] },
  { rule: '3.3', en: 'Candor to the tribunal', zh: '对法庭坦诚', gates: ['citation-audit', 'issue-close-gate'] },
  { rule: '5.1/5.3', en: 'Supervision', zh: '监督', gates: ['risk-escalation-gate', 'hash-audit-chain'] },
  { rule: '1.5', en: 'Fees', zh: '收费', gates: ['deadline-ledger', 'hash-audit-chain'] },
]
export const CN_FILING_NOTE = {
  en: 'China filing: generative-AI service filing + algorithm registration apply to the deployed service, not to this demo.',
  zh: '中国备案：生成式 AI 服务备案与算法登记针对上线服务，不针对本演示。',
}

// ---------- F5 fixture shapes (labels reuse the 5-class L-MARS set above) ----------

export interface DossierAssertion {
  id: string
  text: string
  label: LegalAssertion
  note: string
  aba?: string[]
}

export interface Dossier {
  id: string
  title: string
  memo: string
  assertions: DossierAssertion[]
}

export interface StaircaseState {
  fakeCiteRate: number
  ungroundedRate: number
  strictPassRate: number
}

export interface LegalBundle {
  dossiers: Dossier[]
  staircase: {
    states: { bare: StaircaseState; 'soft-cn': StaircaseState; 'soft-us': StaircaseState; hard: StaircaseState }
    references: { name: string; value: string; citation: string }[]
    source: { kind: string; label: string; citation?: string }[]
  }
}
