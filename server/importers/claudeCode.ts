// F4-5: Claude Code transcript (JSONL) → HarnessEvent normalization.
// Tolerant reader: understands human/assistant/user messages with
// text / tool_use / tool_result content blocks; anything else is counted
// as skipped, never silently mis-parsed. Demo data lives in data/imports/.
import type { HarnessEvent } from '../../shared/events'

export interface ImportResult {
  events: HarnessEvent[]
  skipped: number
}

const est = (s: string) => Math.max(1, Math.ceil(s.length / 4))

interface ContentBlock {
  type?: string
  text?: string
  name?: string
  id?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b): b is ContentBlock => typeof b === 'object' && b !== null && (b as ContentBlock).type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n')
  }
  return ''
}

export function parseClaudeCodeTranscript(jsonl: string, runId = 'imported-claude'): ImportResult {
  const lines = jsonl.split('\n').map((l) => l.trim()).filter(Boolean)
  const events: HarnessEvent[] = []
  let skipped = 0
  let step = 0
  let id = 0
  let task = 'Imported Claude Code transcript'
  let tokens = 0
  const pendingTools = new Map<string, { tool: string; step: number }>()
  const nextId = () => `${runId}-${String(++id).padStart(4, '0')}`
  // ts is event time; the imported log carries no clock, so pin to import order.
  let ts = 0
  const tick = () => (ts += 100)

  const push = (e: Record<string, unknown>) => {
    events.push({ id: nextId(), ts: tick(), runId, scenarioId: 'imported', author: 'harness', ...e } as HarnessEvent)
  }

  let started = false
  const ensureStarted = () => {
    if (started) return
    started = true
    push({ type: 'run.started', model: 'imported-model', task })
  }

  for (const line of lines) {
    let msg: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      msg = JSON.parse(line) as typeof msg
    } catch {
      skipped++
      continue
    }
    const content = msg?.message?.content
    if (!msg || typeof msg !== 'object' || content === undefined) {
      skipped++
      continue
    }
    if (!started && msg.type === 'human' && typeof content === 'string' && content.trim()) {
      task = content.trim().slice(0, 200)
    }
    ensureStarted()
    if (msg.type === 'assistant') {
      const blocks = Array.isArray(content) ? (content as ContentBlock[]) : []
      const thought = textOf(content) || '(no text reply)'
      step++
      const tk = est(thought)
      tokens += tk
      push({ type: 'model.request', step, blocks: [{ layer: 'history', sourceComponent: 'import.claude-code', tokens: tk, positionIndex: 0, preview: thought.slice(0, 200) }], estTokens: tk })
      push({ type: 'model.response', step, thought, stopReason: 'end_turn' })
      for (const b of blocks) {
        if (b.type === 'tool_use' && b.name) {
          const args = typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {})
          push({ type: 'tool.call', step, tool: b.name, argsSummary: args.slice(0, 200) })
          if (b.id) pendingTools.set(b.id, { tool: b.name, step })
        }
      }
    } else if (msg.type === 'user' || msg.type === 'human') {
      const blocks = Array.isArray(content) ? (content as ContentBlock[]) : []
      for (const b of blocks) {
        if ((b.type === 'tool_result' || b.type === 'toolResult') && b.tool_use_id) {
          const hit = pendingTools.get(b.tool_use_id)
          const summary = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
          const tk = est(summary)
          tokens += tk
          push({ type: 'tool.result', step: hit?.step ?? step, tool: hit?.tool ?? 'unknown-tool', tokens: tk, summary: summary.slice(0, 500) })
          pendingTools.delete(b.tool_use_id)
        }
      }
    } else if (msg.type === 'human') {
      // Task line already captured above; nothing to emit.
    } else {
      skipped++
    }
  }

  if (!started) return { events: [], skipped: lines.length }
  push({ type: 'run.finished', success: true, tokens, latencyP50: 0, failureModes: {} })
  return { events, skipped }
}
