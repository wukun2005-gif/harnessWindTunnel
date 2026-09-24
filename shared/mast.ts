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
  'premature-victory': 'MAST FC3 task verification (FM-3.1 premature termination / FM-3.2 incomplete verification / FM-3.3 incorrect verification): declaring success without adequate verification; boundary: a completion claim (goal/coverage/verification declared already met) = this tag — dominant over reasoning-action-mismatch even if the action then diverges from that claim, and over weak-grounding when the failure is the premature claim itself; stopping early because you believe you are done = this tag, missing a real stop signal while continuing = unaware-of-stopping',
  'weak-grounding': 'Conclusion drawn without synthesizing evidence; boundary: real but insufficient/unsynthesized evidence behind a stated conclusion (no completion claim) = this tag; a specific reference that cannot be traced = fabricated-citation; claiming the task complete early = premature-victory',
  'long-horizon-decay': 'Quality collapse in late-stage execution; boundary: a window/request that overflows with no compaction available = this tag (not context-loss); broad late-stage quality/state collapse = this tag, a specific same-step loop without progress = step-repetition',
  'spec-misinterpretation': 'MAST FM-1.1 disobey task specification: misunderstanding of task constraints; boundary: misreading WHAT the spec requires with no out-of-bounds action taken = this tag; if an out-of-bounds action was carried out, use scope-violation instead; ambiguity the spec never stated should have been asked about = fail-to-clarify (not this tag)',
  'fabricated-citation': 'L-MARS (arXiv:2509.00761): Reference non-existent or unsupported; boundary: a specific named/quoted reference that cannot be traced = this tag; conclusions resting on real but thin evidence = weak-grounding',
  'scope-violation': 'Out-of-bounds action or write; boundary: an out-of-bounds action (wrong recipients/writes/side effects) = this tag even when triggered by a misreading of the spec — use spec-misinterpretation only when no out-of-bounds action was taken; actions staying inside bounds while the objective drifts = task-derailment (not this tag)',
  'step-repetition': 'MAST FM-1.3 step repetition (15.7%): retrying the same step without progress; boundary: a specific same-step loop = this tag; broad late-stage quality/state collapse without one identifiable repeated call = long-horizon-decay',
  'reasoning-action-mismatch': 'MAST FM-2.6 reasoning-action mismatch (13.2%): thought says one thing, action does another; boundary: only when no completion claim is made — declaring the task already complete = premature-victory; the objective drifting off task while actions stay in-bounds = task-derailment (not this tag)',
  'unaware-of-stopping': 'MAST FM-1.5 unaware of stopping conditions (12.4%): keeps going past the point of stopping; boundary: missing a real stop/escalate signal while continuing = this tag; stopping early because you wrongly believe the goal is met = premature-victory; the objective itself shifting = task-derailment',
  'task-derailment': 'MAST FM-2.3 task derailment (7.4%): drifting off the task objective; boundary: the objective itself shifting = this tag; failing to notice a stop/escalate condition on the current path = unaware-of-stopping; an out-of-bounds action on the original objective = scope-violation; a single step where thought and action contradict without objective drift = reasoning-action-mismatch',
  'fail-to-clarify': 'MAST FM-2.2 fail to ask for clarification (6.8%): guessing instead of asking; boundary: proceeding through ambiguity the spec never resolved = this tag (you should have asked); a stated requirement that was misread = spec-misinterpretation',
  'context-loss': 'MAST FM-1.4 loss of conversation history (2.8%): earlier findings dropped from context; boundary: earlier material lost THROUGH compaction/summarization mid-run = this tag; window overflow with no compaction available = long-horizon-decay instead',
  other: 'Bucket for the 4 remaining unmapped MAST modes (FM-1.2, FM-2.1, FM-2.4, FM-2.5)',
}
