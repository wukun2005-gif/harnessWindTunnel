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
