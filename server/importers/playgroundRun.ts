// Insight import of native Playground run exports (`kind: 'hwt-playground-run'`),
// i.e. the file the Live tab export downloads. Its `events` array is already a
// HarnessEvent stream, so the work here is only envelope validation, per-event
// schema validation, and the provenance restamp: an external trajectory is
// never a harness intervention (shared/events.ts → author 'imported').
import { event as eventSchema, type HarnessEvent } from '../../shared/events'
import type { ImportResult } from './claudeCode'

interface RunHeader {
  runId?: unknown
  taskTitle?: unknown
  model?: unknown
}

interface Envelope {
  kind?: unknown
  run?: unknown
  events?: unknown
}

export function parsePlaygroundRun(text: string, fallbackRunId = 'imported-hwt'): ImportResult {
  let doc: unknown
  try {
    doc = JSON.parse(text) as unknown
  } catch {
    throw new Error('Playground run export must be one JSON document')
  }
  const envelopes = Array.isArray(doc) ? doc : [doc]
  const events: HarnessEvent[] = []
  let skipped = 0
  let seq = 0
  for (const item of envelopes) {
    const env = (typeof item === 'object' && item !== null ? item : {}) as Envelope
    if (env.kind !== 'hwt-playground-run') {
      throw new Error('not a Playground run export (want kind="hwt-playground-run")')
    }
    if (!Array.isArray(env.events)) throw new Error('Playground run export must carry an events array')
    const header = (typeof env.run === 'object' && env.run !== null ? env.run : {}) as RunHeader
    const rid = typeof header.runId === 'string' && header.runId ? header.runId : fallbackRunId
    const raw = env.events as unknown[]
    // Truncated / cancelled exports can start mid-run; keep the replay header
    // (task + model) so the timeline has something to show.
    if (!raw.some((e) => (e as { type?: unknown }).type === 'run.started')) {
      seq += 1
      events.push({
        id: `${rid}-0000`,
        ts: 0,
        runId: rid,
        scenarioId: 'imported',
        author: 'imported',
        type: 'run.started',
        model: typeof header.model === 'string' && header.model ? header.model : 'imported-model',
        task: typeof header.taskTitle === 'string' && header.taskTitle ? header.taskTitle : 'Imported Playground run',
      } satisfies HarnessEvent)
    }
    for (const e of raw) {
      const src = (typeof e === 'object' && e !== null ? e : {}) as Record<string, unknown>
      seq += 1
      const parsed = eventSchema.safeParse({
        ...src,
        id: typeof src.id === 'string' && src.id ? src.id : `${rid}-${String(seq).padStart(4, '0')}`,
        ts: typeof src.ts === 'number' ? src.ts : seq,
        runId: rid,
        scenarioId: 'imported',
        author: 'imported',
      })
      if (parsed.success) events.push(parsed.data)
      else skipped += 1
    }
  }
  return { events, skipped }
}
