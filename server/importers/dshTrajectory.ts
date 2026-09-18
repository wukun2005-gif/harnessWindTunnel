// F4-5: dsh Trajectory → HarnessEvent normalization.
// Accepts the documented demo shape { runId?, task?, steps[] } where each step
// carries thought / tool / args / observation. Unknown shapes are rejected
// with a thrown Error (the API maps it to 400); unknown step fields are ignored.
import type { HarnessEvent } from '../../shared/events'
import type { ImportResult } from './claudeCode'

const est = (s: string) => Math.max(1, Math.ceil(s.length / 4))

interface DshStep {
  thought?: string
  tool?: string
  args?: string
  observation?: string
}

export function parseDshTrajectory(json: unknown, runId = 'imported-dsh'): ImportResult {
  if (typeof json !== 'object' || json === null || !Array.isArray((json as { steps?: unknown }).steps)) {
    throw new Error('dsh trajectory must be an object with a steps array')
  }
  const doc = json as { runId?: string; task?: string; steps: DshStep[] }
  const rid = typeof doc.runId === 'string' && doc.runId ? doc.runId : runId
  const task = typeof doc.task === 'string' && doc.task ? doc.task.slice(0, 200) : 'Imported dsh trajectory'
  const events: HarnessEvent[] = []
  let id = 0
  let ts = 0
  let tokens = 0
  const push = (e: Record<string, unknown>) => {
    events.push({ id: `${rid}-${String(++id).padStart(4, '0')}`, ts: (ts += 100), runId: rid, scenarioId: 'imported', author: 'harness', ...e } as HarnessEvent)
  }
  push({ type: 'run.started', model: 'imported-model', task })
  doc.steps.forEach((s, i) => {
    const step = i + 1
    const thought = typeof s.thought === 'string' && s.thought ? s.thought : '(no thought recorded)'
    const tk = est(thought)
    tokens += tk
    push({ type: 'model.request', step, blocks: [{ layer: 'history', sourceComponent: 'import.dsh', tokens: tk, positionIndex: 0, preview: thought.slice(0, 200) }], estTokens: tk })
    push({ type: 'model.response', step, thought, stopReason: 'end_turn' })
    if (typeof s.tool === 'string' && s.tool) {
      const args = typeof s.args === 'string' ? s.args : ''
      push({ type: 'tool.call', step, tool: s.tool, argsSummary: args.slice(0, 200) })
      const obs = typeof s.observation === 'string' ? s.observation : ''
      const otk = est(obs || '-')
      tokens += otk
      push({ type: 'tool.result', step, tool: s.tool, tokens: otk, summary: (obs || '(no observation)').slice(0, 500) })
    }
  })
  push({ type: 'run.finished', success: true, tokens, latencyP50: 0, failureModes: {} })
  return { events, skipped: 0 }
}
