// Failure tags for knowledge-work runs, synthesized bottom-up from
// scenario Traps and multiple research threads (see PRD 2.5–2.7), aligned to
// MAST (arXiv:2503.13657: 14 modes FM-1.1–FM-3.3 in 3 groups) where possible:
//   premature-victory ~= MAST FC3 merged (FM-3.1 6.2% + FM-3.2 8.2% + FM-3.3 9.1%)
//     + research/coding Traps + module ⑭ self-check
//   spec-misinterpretation ~= MAST FM-1.1 (11.8%) + churn-analysis Trap (metric scope)
//   weak-grounding ~= task-family table (unsupported conclusions, single source)
//     + docStudio sentence-level provenance / L-MARS sufficiency thinking
//   long-horizon-decay ~= task-family table (late-stage collapse, state loss)
//     + Context Rot / RULER / Claude Code compression literature
//   fabricated-citation ~= Mata v. Avianca case line + L-MARS citation audit
//     (bridge tag) + VeritasBench
//   scope-violation ~= workflow Trap (mis-sent mail) + ToolPrivBench / Palisade
//     least-privilege security line
//   step-repetition = MAST FM-1.3 (15.7%): same tool call retried without progress
//   reasoning-action-mismatch = MAST FM-2.6 (13.2%): thought and action disagree
//   unaware-of-stopping = MAST FM-1.5 (12.4%): runs past stopping conditions
//   task-derailment = MAST FM-2.3 (7.4%): objective drifts off task
//   fail-to-clarify = MAST FM-2.2 (6.8%): proceeds on ambiguity instead of asking
//   context-loss = MAST FM-1.4 (2.8%): earlier findings dropped from context
// Only premature-victory and spec-misinterpretation come straight from MAST;
// weak-grounding, long-horizon-decay, fabricated-citation and scope-violation
// are synthesized from task-family Traps + L-MARS/context/security literature.
// `other` covers the 4 remaining unmapped paper modes: FM-1.2, FM-2.1,
// FM-2.4, FM-2.5 (multi-agent-specific and low prevalence; see PRD 2.5).
// The 12 exist because the first 6 close over the designed Trap space
// (PRD 2.6.4) and the latter 6 close the paper-review gaps (PRD 2.5.4).
// Legal atomic assertion labels (L-MARS, 5) live separately in
// shared/legal.ts — do not merge them into MastTag. `fabricated-citation`
// is the bridge tag cited by both taxonomies (MAST view + L-MARS
// arXiv:2509.00761 evidence).
export type MastTag =
  | 'premature-victory'
  | 'weak-grounding'
  | 'long-horizon-decay'
  | 'spec-misinterpretation'
  | 'fabricated-citation'
  | 'scope-violation'
  | 'step-repetition'
  | 'reasoning-action-mismatch'
  | 'unaware-of-stopping'
  | 'task-derailment'
  | 'fail-to-clarify'
  | 'context-loss'
  | 'other'

export const MAST_LABEL: Record<MastTag, string> = {
  'premature-victory': 'Premature Victory',
  'weak-grounding': 'Weak Grounding',
  'long-horizon-decay': 'Long-Horizon Decay',
  'spec-misinterpretation': 'Spec Misinterpretation',
  'fabricated-citation': 'Fabricated Citation',
  'scope-violation': 'Scope Violation',
  'step-repetition': 'Step Repetition',
  'reasoning-action-mismatch': 'Reasoning-Action Mismatch',
  'unaware-of-stopping': 'Unaware of Stopping',
  'task-derailment': 'Task Derailment',
  'fail-to-clarify': 'Fail to Clarify',
  'context-loss': 'Context Loss',
  other: 'Other',
}

export const MAST_HINT: Record<MastTag, string> = {
  'premature-victory': 'MAST FC3 task verification (FM-3.1 premature termination / FM-3.2 incomplete verification / FM-3.3 incorrect verification): declaring success without adequate verification',
  'weak-grounding': 'Conclusion drawn without synthesizing evidence',
  'long-horizon-decay': 'Quality collapse in late-stage execution',
  'spec-misinterpretation': 'MAST FM-1.1 disobey task specification: misunderstanding of task constraints',
  'fabricated-citation': 'L-MARS (arXiv:2509.00761): Reference non-existent or unsupported',
  'scope-violation': 'Out-of-bounds action or write',
  'step-repetition': 'MAST FM-1.3 step repetition (15.7%): retrying the same step without progress',
  'reasoning-action-mismatch': 'MAST FM-2.6 reasoning-action mismatch (13.2%): thought says one thing, action does another',
  'unaware-of-stopping': 'MAST FM-1.5 unaware of stopping conditions (12.4%): keeps going past the point of stopping',
  'task-derailment': 'MAST FM-2.3 task derailment (7.4%): drifting off the task objective',
  'fail-to-clarify': 'MAST FM-2.2 fail to ask for clarification (6.8%): guessing instead of asking',
  'context-loss': 'MAST FM-1.4 loss of conversation history (2.8%): earlier findings dropped from context',
  other: 'Bucket for the 4 remaining unmapped MAST modes (FM-1.2, FM-2.1, FM-2.4, FM-2.5)',
}
