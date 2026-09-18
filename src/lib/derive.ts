import type { Author, ContextBlock, HarnessEvent } from '../../shared/events'

export type MarkerKind = 'hook' | 'perm' | 'shaper' | 'verifier-reject' | 'verifier-pass' | 'fork' | 'join' | 'compact' | 'fail' | 'optimizer' | 'lint-reject' | 'lint-pass'

export interface Marker {
  kind: MarkerKind
  label: string
  detail: string
  idx: number // event index (for playhead filtering)
  author?: Author // who emitted the source event; backfilled from events[idx]
}

export interface ToolUse {
  tool: string
  argsSummary: string
  tokens?: number
  summary?: string
}

export interface DerivedStep {
  step: number
  reqIdx: number // event index of model.request
  blocks: ContextBlock[]
  estTokens: number
  thought: string
  tools: ToolUse[]
  markers: Marker[]
  /** Post-hoc failure annotations (narrator labels, NOT harness interventions) */
  tags: Marker[]
}

export interface DerivedRun {
  events: HarnessEvent[]
  steps: DerivedStep[]
  globalMarkers: { text: string; kind: string }[]
  finish?: Extract<HarnessEvent, { type: 'run.finished' }>
  start?: Extract<HarnessEvent, { type: 'run.started' }>
}

const MK: Record<MarkerKind, (d: string, idx: number) => Marker> = {
  hook: (d, idx) => ({ kind: 'hook', label: 'Hook Intercept', detail: d, idx }),
  perm: (d, idx) => ({ kind: 'perm', label: 'Permission Gate', detail: d, idx }),
  shaper: (d, idx) => ({ kind: 'shaper', label: 'Shaper Fired', detail: d, idx }),
  'verifier-reject': (d, idx) => ({ kind: 'verifier-reject', label: 'Verifier Rejected', detail: d, idx }),
  'verifier-pass': (d, idx) => ({ kind: 'verifier-pass', label: 'Verifier Passed', detail: d, idx }),
  'lint-reject': (d, idx) => ({ kind: 'lint-reject', label: 'Lint Rejected', detail: d, idx }),
  'lint-pass': (d, idx) => ({ kind: 'lint-pass', label: 'Lint Passed', detail: d, idx }),
  fork: (d, idx) => ({ kind: 'fork', label: 'Agent Fork', detail: d, idx }),
  join: (d, idx) => ({ kind: 'join', label: 'Agent Join', detail: d, idx }),
  compact: (d, idx) => ({ kind: 'compact', label: 'Compaction Boundary', detail: d, idx }),
  fail: (d, idx) => ({ kind: 'fail', label: 'MAST Failure Tag', detail: d, idx }),
  optimizer: (d, idx) => ({ kind: 'optimizer', label: 'Optimizer', detail: d, idx }),
}

export function deriveRun(events: HarnessEvent[]): DerivedRun {
  const steps = new Map<number, DerivedStep>()
  const start = events.find((e): e is Extract<HarnessEvent, { type: 'run.started' }> => e.type === 'run.started')
  const finish = events.find((e): e is Extract<HarnessEvent, { type: 'run.finished' }> => e.type === 'run.finished')

  const get = (n: number) => {
    if (!steps.has(n)) steps.set(n, { step: n, reqIdx: 0, blocks: [], estTokens: 0, thought: '', tools: [], markers: [], tags: [] })
    return steps.get(n)!
  }
  // Attach to nearest existing step or step 0
  let cur = 0
  events.forEach((e, i) => {
    switch (e.type) {
      case 'run.started':
        break
      case 'model.request': {
        cur = e.step
        const s = get(e.step)
        s.blocks = e.blocks
        s.estTokens = e.estTokens
        s.reqIdx = i
        break
      }
      case 'model.response':
        get(e.step).thought = e.thought
        break
      case 'tool.call':
        get(e.step).tools.push({ tool: e.tool, argsSummary: e.argsSummary })
        break
      case 'tool.result': {
        const s = get(e.step)
        const t = s.tools.find((x) => x.tool === e.tool && x.tokens === undefined)
        if (t) { t.tokens = e.tokens; t.summary = e.summary } else s.tools.push({ tool: e.tool, argsSummary: '', tokens: e.tokens, summary: e.summary })
        break
      }
      case 'shaper.fire':
        get(e.step).markers.push(MK.shaper(`${e.shaper} freed ${e.freedTokens} tk — ${e.note}`, i))
        break
      case 'hook.decision':
        get(e.step).markers.push(MK.hook(`${e.hook}: ${e.verdict} — ${e.reason}`, i))
        break
      case 'permission.request':
        get(e.step).markers.push(MK.perm(`Request ${e.scope} (${e.riskLevel})`, i))
        break
      case 'permission.granted':
        get(e.step).markers.push(MK.perm(`${e.scope} granted via ${e.via}`, i))
        break
      case 'verifier.verdict':
        get(e.step).markers.push(
          e.verdict === 'reject'
            ? MK['verifier-reject'](`${e.verifier} rejected — ${e.reason}`, i)
            : MK['verifier-pass'](`${e.verifier} passed — ${e.reason}`, i)
        )
        break
      case 'sensor.lint':
        get(e.step).markers.push(
          e.verdict === 'reject'
            ? MK['lint-reject'](`${e.lint} rejected — ${e.reason}`, i)
            : MK['lint-pass'](`${e.lint} passed — ${e.reason}`, i)
        )
        break
      case 'agent.fork':
        get(e.step).markers.push(MK.fork(`fork ${e.childId} — ${e.purpose}`, i))
        break
      case 'agent.join':
        get(e.step).markers.push(MK.join(`join ${e.childId} — ${e.summary}`, i))
        break
      case 'optimizer.fire':
        get(e.step).markers.push(MK.optimizer(`${e.action} — ${e.detail}`, i))
        break
      case 'compact.boundary':
        get(e.step).markers.push(MK.compact(`${e.strategy}: ${e.beforeTokens} → ${e.afterTokens} tk`, i))
        break
      case 'failure.tag':
        get(e.step).tags.push(MK.fail(`${e.mast} (${Math.round(e.confidence * 100)}%) — ${e.note}`, i))
        break
      case 'run.finished':
        break
    }
  })
  // Backfill authorship from source events (idx IS the event index).
  // Stale data without `author` degrades gracefully (stays undefined → treated as harness).
  const list = [...steps.values()].sort((a, b) => a.step - b.step)
  for (const s of list) {
    for (const m of [...s.markers, ...s.tags]) {
      const ev = events[m.idx]
      if (ev) m.author = ev.author
    }
  }
  const globalMarkers: { text: string; kind: string }[] = []
  if (start) globalMarkers.push({ text: `Run started · ${start.model}`, kind: 'shaper' })
  if (finish) globalMarkers.push({ text: finish.success ? 'Run succeeded' : 'Run failed', kind: finish.success ? 'verifier-pass' : 'fail' })
  return { events, steps: list, globalMarkers, finish, start }
}

/** Step-level aligned diff: returns pairs per line (null = missing on one side), plus first divergence line number */
export function alignSteps(a: DerivedStep[], b: DerivedStep[]) {
  const rows: { n: number; a: DerivedStep | null; b: DerivedStep | null; same: boolean }[] = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const sa = a[i] ?? null
    const sb = b[i] ?? null
    const same = !!sa && !!sb && sa.thought === sb.thought && JSON.stringify(sa.tools.map((t) => t.tool)) === JSON.stringify(sb?.tools.map((t) => t.tool))
    rows.push({ n: i + 1, a: sa, b: sb, same })
  }
  return rows
}

export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`)
export const fmtMs = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}s` : `${n}ms`)
