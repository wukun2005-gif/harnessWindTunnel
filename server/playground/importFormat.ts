// M3 import of mainstream trajectory formats (design §14.1 / §10 M3).
//
// Accepted, auto-detected by content (extension .json/.jsonl/.txt is only a hint):
//   - native hwt envelope(s)    — hwt-playground-run JSON / JSON array / JSONL
//   - Claude Code transcript    — JSONL, one JSON per line,
//                                 human / assistant / tool_use / tool_result
//   - dsh trajectory            — single JSON object { runId?, task?, steps[] },
//                                 each step thought / tool / args / observation
//   - hwt TXT report            — the human-readable export (lossy: no events)
//   - plain text                — treated as a final answer, unlinked
//
// Hard rule for every *external* format:
//   - success / score / verdict are NEVER copied from the source — the foreign
//     run.finished.success is not ours. They land with success=null and are
//     excluded from every aggregate until the user links a task and re-scores
//     (see /runs/:id/rescore).
import { BASE_CONFIG, fingerprint as fpOf, type HarnessConfig } from '../../shared/config'
import type { HarnessEvent } from '../../shared/events'
import { parseClaudeCodeTranscript } from '../importers/claudeCode'
import { parseDshTrajectory } from '../importers/dshTrajectory'
import { configVersionInfo } from './presets'
import type { ImportableRun } from './liveDb'
import type {
  ControlsSnapshot,
  PgDomain,
  PgSplit,
  RunDetail,
} from '../../shared/playground'

export interface ImportReport {
  items: ImportableRun[]
  /** How many input lines / steps were ignored, summed across files. */
  skipped: number
  /** Format actually detected per item, shown back to the user. */
  formats: string[]
}

/** A taskId the imported run is not linked to a real eval task yet. */
export const UNLINKED_TASK = 'IMPORTED'

let seq = 0
function newImportId(): string {
  seq += 1
  return `imp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}_${seq}`
}

/** Last model.response text = the final answer (later responses supersede earlier). */
function finalAnswer(events: HarnessEvent[]): string {
  let answer = ''
  for (const e of events) {
    if (e.type === 'model.response') answer = e.thought
  }
  return answer
}

function startedTask(events: HarnessEvent[], fallback: string): { title: string; model: string } {
  let title = fallback
  let model = 'imported-model'
  for (const e of events) {
    if (e.type === 'run.started') {
      title = e.task || title
      model = e.model || model
    }
  }
  return { title: title.slice(0, 200), model }
}

function finishedTokens(events: HarnessEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.type === 'run.finished') return e.tokens
  }
  return null
}

/**
 * Build the run record for a normalized external event stream.
 *
 * The harness config is the baseline (we cannot claim a foreign trajectory used
 * any of our controls), so it lands on the bare audit rung. provenance is
 * carried by the events' author='imported' stamp added in importRun.
 */
function runFromEvents(
  events: HarnessEvent[],
  format: string,
  opts: { taskTitle?: string; domain?: PgDomain; split?: PgSplit } = {},
): ImportableRun {
  const runId = newImportId()
  const config: HarnessConfig = { ...BASE_CONFIG }
  const now = new Date().toISOString()
  const { title, model } = startedTask(events, opts.taskTitle ?? 'Imported trajectory')
  const cvi = configVersionInfo(config)
  const base = {
    runId,
    scenarioId: 'imported',
    taskId: UNLINKED_TASK,
    taskTitle: title,
    domain: (opts.domain ?? 'general') as PgDomain,
    split: (opts.split ?? 'repair') as PgSplit,
    presetId: null,
    fingerprint: fpOf(config),
    status: 'scored' as const,
    source: 'imported' as const,
    success: null,
    score: null,
    tokens: finishedTokens(events),
    latencyMs: null,
    failureTags: [],
    model,
    temperature: null,
    seed: null,
    eventCount: events.length,
    hasTrajectory: events.length > 0,
    error: null,
    createdAt: now,
    startedAt: null,
    finishedAt: now,
    config,
    mounts: {},
    provider: null,
    maxTokens: null,
    answer: finalAnswer(events),
    verdict: null,
    jevResult: null,
    materials: null,
    configVersion: cvi,
    security: {
      designed: null,
      observed: null,
      blastRadius: [],
    },
  } as unknown as Omit<RunDetail, 'events'>
  void format
  return { run: base, events: events.map((e) => ({ ...e, runId })) }
}

/** A run with an answer but no trajectory (TXT / plain text). */
function metricsOnlyRun(
  answer: string,
  title: string,
  meta: {
    domain?: PgDomain
    split?: PgSplit
    taskId?: string
    model?: string
    createdAt?: string
  } = {},
): ImportableRun {
  const runId = newImportId()
  const config: HarnessConfig = { ...BASE_CONFIG }
  const now = meta.createdAt ?? new Date().toISOString()
  const cvi = configVersionInfo(config)
  const base = {
    runId,
    scenarioId: 'imported',
    taskId: meta.taskId ?? UNLINKED_TASK,
    taskTitle: title,
    domain: (meta.domain ?? 'general') as PgDomain,
    split: (meta.split ?? 'repair') as PgSplit,
    presetId: null,
    fingerprint: fpOf(config),
    status: 'scored' as const,
    source: 'imported' as const,
    success: null,
    score: null,
    tokens: null,
    latencyMs: null,
    failureTags: [],
    model: meta.model ?? 'imported-model',
    temperature: null,
    seed: null,
    eventCount: 0,
    hasTrajectory: false,
    error: null,
    createdAt: now,
    startedAt: null,
    finishedAt: now,
    config,
    mounts: {},
    provider: null,
    maxTokens: null,
    answer,
    verdict: null,
    jevResult: null,
    materials: null,
    configVersion: cvi,
    security: { designed: null, observed: null, blastRadius: [] },
  } as unknown as Omit<RunDetail, 'events'>
  return { run: base, events: [] }
}

// ── dsh detection ─────────────────────────────────────────────────────────

function isDshObject(obj: unknown): boolean {
  return typeof obj === 'object' && obj !== null && Array.isArray((obj as { steps?: unknown }).steps)
}

// ── TXT report parsing (lossy) ────────────────────────────────────────────

interface TxtHeader {
  taskId?: string
  taskTitle?: string
  domain?: PgDomain
  split?: PgSplit
  preset?: string
  model?: string
  createdAt?: string
}

function section(text: string, marker: string, endMarker?: string): string | null {
  const start = text.indexOf(marker)
  if (start < 0) return null
  const body = text.slice(start + marker.length)
  if (endMarker) {
    // Match the whole marker line (dashes + word), not just the word, so the
    // trailing rule of the separator isn't left in the answer.
    const re = new RegExp(`^[─\\s]*${endMarker}`, 'm')
    const m = body.match(re)
    if (m && m.index != null) return body.slice(0, m.index).trim()
    const end = body.indexOf(endMarker)
    if (end >= 0) return body.slice(0, end).trim()
  }
  return body.trim()
}

function parseTxtHeader(text: string): TxtHeader {
  const out: TxtHeader = {}
  const grab = (re: RegExp): string | null => {
    const m = text.match(re)
    return m ? m[1]?.trim() : null
  }
  // task : [L1] some title
  const taskLine = grab(/^task\s*:\s*\[([^\]]+)\]\s*(.*)$/m)
  out.taskId = taskLine ?? undefined
  const titleLine = text.match(/^task\s*:\s*\[[^\]]+\]\s*(.*)$/m)
  out.taskTitle = titleLine ? titleLine[1]?.trim() : undefined
  const ds = grab(/^domain\/split\s*:\s*([a-z]+)\s*\/\s*([a-z]+)/m)
  if (ds) {
    const line = text.match(/^domain\/split\s*:\s*([a-z]+)\s*\/\s*([a-z]+)/m)
    out.domain = line?.[1] as PgDomain | undefined
    out.split = line?.[2] as PgSplit | undefined
  }
  out.model = grab(/^model\s*:\s*(.+)$/m) ?? undefined
  out.createdAt = grab(/^createdAt\s*:\s*(.+)$/m) ?? undefined
  return out
}

/** Recognize our own TXT export (the banner), else false = plain text. */
function isHwtTxtReport(text: string): boolean {
  return text.includes('HWT Playground Live Run')
}

// ── top-level detection ───────────────────────────────────────────────────

/**
 * Parse external (non-native) content. Throws when nothing usable can be built.
 * Native envelopes are handled separately by the route via parseEnvelopes.
 */
export function parseExternalImport(text: string): ImportReport {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('import content is empty')

  const first = trimmed[0]
  if (first === '{' || first === '[') {
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      // Bracketed but not a single valid JSON — could be bracketed JSONL.
      return parseLineBased(trimmed)
    }
    // dsh single object.
    if (isDshObject(obj)) {
      const { events, skipped } = parseDshTrajectory(obj)
      return { items: [runFromEvents(events, 'dsh')], skipped, formats: ['dsh'] }
    }
    // JSON array: either dsh objects or native envelopes.
    if (Array.isArray(obj)) {
      if (obj.every(isDshObject)) {
        const items: ImportableRun[] = []
        let skipped = 0
        for (const d of obj) {
          const r = parseDshTrajectory(d)
          items.push(runFromEvents(r.events, 'dsh'))
          skipped += r.skipped
        }
        return { items, skipped, formats: obj.map(() => 'dsh') }
      }
      throw new Error('unrecognised JSON array shape (only a dsh steps array or an hwt envelope array is supported)')
    }
    throw new Error('unrecognised JSON object shape (a dsh {steps:[]} or an hwt-playground-run envelope is supported)')
  }

  return parseLineBased(trimmed)
}

/** JSONL (Claude / native) or TXT / plain text. */
function parseLineBased(text: string): ImportReport {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)

  // Classify lines that parse as JSON.
  const jsonLines: unknown[] = []
  for (const line of lines) {
    try {
      jsonLines.push(JSON.parse(line))
    } catch {
      /* non-JSON line */
    }
  }

  // Claude Code transcript: rows carry a type in human/assistant/user plus message.
  const claudeRows = jsonLines.filter(
    (o): boolean =>
      typeof o === 'object' &&
      o !== null &&
      typeof (o as { type?: string }).type === 'string' &&
      ['human', 'assistant', 'user'].includes((o as { type?: string }).type ?? '') &&
      typeof (o as { message?: unknown }).message === 'object',
  )
  if (claudeRows.length > 0 && claudeRows.length >= jsonLines.length / 2) {
    const { events, skipped } = parseClaudeCodeTranscript(text)
    if (events.length > 0) {
      return { items: [runFromEvents(events, 'claude')], skipped, formats: ['claude'] }
    }
  }

  // Native hwt envelopes as JSONL are handled by the route's parseEnvelopes
  // (with validation) before this external parser is reached. JSON rows that
  // are neither Claude nor dsh are not reconstructable, so they count as
  // skipped rather than being silently dropped.

  // Otherwise treat as text — our TXT report or a plain answer.
  if (isHwtTxtReport(text)) {
    const header = parseTxtHeader(text)
    const answer = section(text, 'answer', 'trajectory') ?? text
    return {
      items: [
        metricsOnlyRun(answer, header.taskTitle ?? 'Imported TXT report', {
          domain: header.domain,
          split: header.split,
          taskId: header.taskId,
          model: header.model,
          createdAt: header.createdAt,
        }),
      ],
      skipped: 0,
      formats: ['txt'],
    }
  }

  // Plain text: the whole thing is an answer with no task.
  return {
    items: [metricsOnlyRun(text, 'Imported text (no linked task)')],
    skipped: 0,
    formats: ['txt'],
  }
}

/** Re-export for the controls snapshot type (used by tests / UI wording). */
export type { ControlsSnapshot }
