// M2 HTTP routes for live playground runs, mounted under /api/playground.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { event as eventSchema } from '../../shared/events'
import type { HarnessConfig } from '../../shared/config'
import type {
  ChatTarget,
  CreateRunsRequest,
  PlaygroundRunFile,
  PgDomain,
  PgPresetId,
  RunSource,
  RunStatus,
  RunTargets,
} from '../../shared/playground'
import { getSetting } from '../settingsStore'
import { getAllChunks, getAllSources } from '../knowledge/db'
import { PRESET_PROVIDERS, isDecisionProvider } from '../../shared/provider'
import { getTask, loadEvalSet } from './evalset'
import { PG_PRESETS, resolveConfig } from './presets'
import { computeLiveMetrics } from './metrics'
import { renderRunTxt } from './exportFormat'
import { deleteRun, getRunDetail, importRun, listRuns, relinkRun } from './liveDb'
import { parseExternalImport } from './importFormat'
import { createRun, dossierTexts, enqueueRun } from './runner'
import { scoreAnswer } from './scorer'
import { rougeAgainstReference } from './rouge'
import { analyze, applyCard, rollbackTo, getEvoState, startGateVerify, startAutoEvolve, startTopRace } from './evolve'

type RunDetailShape = NonNullable<ReturnType<typeof getRunDetail>>

/**
 * Runs scored before ROUGE joined the verdict carry no `rouge` reading. It is a
 * pure function of the answer and the task's reference answer, both of which are
 * stored, so fill it in on read instead of forcing every historical run to be
 * re-scored just to see the number.
 */
function withRouge(detail: RunDetailShape): RunDetailShape {
  if (!detail.verdict || detail.verdict.rouge || !detail.answer) return detail
  const reference = getTask(detail.taskId)?.referenceAnswer
  if (!reference) return detail
  return {
    ...detail,
    verdict: { ...detail.verdict, rouge: rougeAgainstReference(detail.answer, reference) },
  }
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function sendText(res: ServerResponse, code: number, text: string, contentType: string, filename?: string): void {
  const headers: Record<string, string> = { 'Content-Type': `${contentType}; charset=utf-8`, 'Cache-Control': 'no-store' }
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`
  res.writeHead(code, headers)
  res.end(text)
}

function readBody(req: IncomingMessage, limit = 20_000_000): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let n = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > limit) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function listTargets(): RunTargets {
  const bundle = getSetting('provider_all') as { providers?: Array<{ providerId?: string; baseUrl?: string; apiKeyRef?: string; apiKey?: string; defaultModelId?: string; modelIds?: string[]; enabled?: boolean }> } | null
  const providers: ChatTarget[] = (bundle?.providers ?? []).map((p) => {
    const preset = PRESET_PROVIDERS.find((q) => q.id === p.providerId)
    const hasKey = !!(p.apiKeyRef ?? p.apiKey ?? '').trim()
    return {
      providerId: p.providerId ?? 'custom',
      name: preset?.name ?? p.providerId ?? 'Custom',
      baseUrl: (p.baseUrl ?? '').trim(),
      model: p.defaultModelId ?? p.modelIds?.[0] ?? '',
      models: p.modelIds ?? (p.defaultModelId ? [p.defaultModelId] : []),
      enabled: !!p.enabled,
      hasKey,
      // Same predicate the runner uses to pick a live model: the Jev cards have
      // keys but no /chat/completions, so they are never a valid run target.
      kind: isDecisionProvider(p.providerId ?? '') ? ('decision' as const) : ('chat' as const),
    }
  })
  const sources = getAllSources()
  const chunks = getAllChunks()
  return {
    providers,
    kb: {
      sources: sources.length,
      chunks: chunks.length,
      embedderConfigured: chunks.some((c) => c.embedded > 0),
      ready: sources.length > 0,
    },
  }
}

function envelopeFor(runId: string): PlaygroundRunFile | { error: string } {
  const found = getRunDetail(runId)
  if (!found) return { error: `run not found: ${runId}` }
  const { events, ...run } = withRouge(found)
  // 卷宗正文只在导出时补上（export-only）：入库的 materials 只存元信息（sha/字符数），
  // 正文不落库避免每条 run 都背着一份卷宗。复盘导出件必须能独立看——不回源文件也能读到题面材料。
  const texts = dossierTexts(getTask(run.taskId))
  const dossier = run.materials
    ? { ...run.materials, dossier: run.materials.dossier.map((d, i) => ({ ...d, text: texts[i] ?? '' })) }
    : null
  return {
    kind: 'hwt-playground-run',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    run: { ...run, materials: dossier },
    events,
  }
}

const NO_NATIVE = 'NO_NATIVE_ENVELOPE'

function parseEnvelopes(raw: string): PlaygroundRunFile[] {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('empty file')
  // A single JSON document first (object or array).
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let doc: unknown
    try {
      doc = JSON.parse(trimmed)
    } catch {
      doc = undefined // bracketed body that is not one JSON — JSONL below
    }
    if (doc !== undefined) {
      if (Array.isArray(doc)) {
        const rows = (doc as PlaygroundRunFile[]).filter((e) => e && e.kind === 'hwt-playground-run')
        if (rows.length === 0) throw new Error(NO_NATIVE)
        return rows
      }
      if ((doc as PlaygroundRunFile).kind === 'hwt-playground-run') return [doc as PlaygroundRunFile]
      throw new Error(NO_NATIVE)
    }
  }
  // JSONL: one JSON object per line, keep hwt envelopes.
  const rows = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as PlaygroundRunFile
      } catch {
        return null
      }
    })
    .filter((e): e is PlaygroundRunFile => e != null && e.kind === 'hwt-playground-run')
  if (rows.length === 0) throw new Error(NO_NATIVE)
  return rows
}

/**
 * Schema gate for imported trajectories. Anti-forgery rule (design §14.5):
 * reject with a field-level 400 — never "best effort" a guess. This must check
 * the run object too: a payload missing `config` used to reach SQLite and blow
 * up as a 500, which tells the caller nothing about which field was wrong.
 */
const RUN_STRING_FIELDS = [
  'scenarioId', 'taskId', 'taskTitle', 'domain', 'split', 'fingerprint', 'status', 'source', 'model', 'createdAt',
] as const

function validateEnvelope(env: PlaygroundRunFile): string | null {
  if (!env || typeof env !== 'object') return 'not a valid JSON object'
  if (env.kind !== 'hwt-playground-run') return 'missing kind=hwt-playground-run'
  if (env.schemaVersion !== 1) return `unsupported schemaVersion: ${String(env.schemaVersion)}`

  const run = env.run as Record<string, unknown> | undefined
  if (!run) return 'missing the run object'
  for (const f of RUN_STRING_FIELDS) {
    if (typeof run[f] !== 'string' || !(run[f] as string).trim()) return `run.${f} is missing or not a non-empty string`
  }
  if (!run['config'] || typeof run['config'] !== 'object') return 'run.config is missing (the config snapshot is required — it cannot be guessed)'
  if (!Array.isArray(env.events)) return 'events must be an array (an empty array is fine, omitting it is not)'

  for (const ev of env.events ?? []) {
    const parsed = eventSchema.safeParse(ev)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return `event ${(ev as { id?: string }).id ?? '?'} failed validation: ${issue ? `${issue.path.join('.')} ${issue.message}` : 'invalid event'}`
    }
  }
  return null
}

export async function handleLiveRoute(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  method: string | undefined,
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')

  // GET /api/playground/presets
  if (p === '/api/playground/presets' && method === 'GET') {
    send(res, 200, { presets: PG_PRESETS, evalSet: { total: loadEvalSet().total } })
    return true
  }

  // GET /api/playground/targets
  if (p === '/api/playground/targets' && method === 'GET') {
    send(res, 200, listTargets())
    return true
  }

  // GET /api/playground/metrics
  if (p === '/api/playground/metrics' && method === 'GET') {
    send(res, 200, computeLiveMetrics())
    return true
  }

  // POST /api/playground/runs — enqueue one or more live runs
  if (p === '/api/playground/runs' && method === 'POST') {
    const body = JSON.parse(await readBody(req)) as CreateRunsRequest
    if (!Array.isArray(body.taskIds) || body.taskIds.length === 0) {
      send(res, 400, { ok: false, error: 'taskIds must not be empty' })
      return true
    }
    const { config, mounts, presetId } = resolveConfig(body.presetId, body.config as HarnessConfig | undefined)
    const created: Array<{ runId: string; taskId: string }> = []
    for (const taskId of body.taskIds.slice(0, 50)) {
      const task = getTask(taskId)
      if (!task) {
        send(res, 404, { ok: false, error: `task not found: ${taskId}`, created })
        return true
      }
      const made = createRun({
        task,
        config,
        mounts,
        presetId: (presetId ?? null) as PgPresetId | null,
        providerId: body.providerId,
        model: body.model,
        temperature: body.temperature,
        seed: body.seed,
        maxTokens: body.maxTokens,
      })
      if ('error' in made) {
        send(res, 400, { ok: false, error: made.error, created })
        return true
      }
      created.push(made)
      enqueueRun(made.runId)
    }
    send(res, 202, { ok: true, created })
    return true
  }

  // GET /api/playground/runs?...filters
  if (p === '/api/playground/runs' && method === 'GET') {
    const limit = Number(url.searchParams.get('limit') ?? '200')
    send(
      res,
      200,
      listRuns({
        taskId: url.searchParams.get('taskId') ?? undefined,
        domain: (url.searchParams.get('domain') as PgDomain | null) ?? undefined,
        fingerprint: url.searchParams.get('fingerprint') ?? undefined,
        presetId: (url.searchParams.get('presetId') as PgPresetId | null) ?? undefined,
        model: url.searchParams.get('model') ?? undefined,
        tag: url.searchParams.get('tag') ?? undefined,
        source: (url.searchParams.get('source') as RunSource | null) ?? undefined,
        status: (url.searchParams.get('status') as RunStatus | null) ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
        limit: Number.isFinite(limit) ? limit : 200,
      }),
    )
    return true
  }

  // Bulk export: GET /api/playground/export?ids=a,b&format=json|jsonl|txt
  if (p === '/api/playground/export' && method === 'GET') {
    const ids = (url.searchParams.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    const format = url.searchParams.get('format') ?? 'json'
    const envelopes = ids.map(envelopeFor)
    const missing = envelopes.findIndex((e) => 'error' in e)
    if (missing >= 0) {
      send(res, 404, { ok: false, error: (envelopes[missing] as { error: string }).error })
      return true
    }
    const files = envelopes as PlaygroundRunFile[]
    if (format === 'jsonl') {
      sendText(res, 200, files.map((f) => JSON.stringify(f)).join('\n'), 'application/x-jsonlines', `playground-runs-${files.length}.jsonl`)
    } else if (format === 'txt') {
      const txt = files.map((f) => renderRunTxt(f.run, f.events)).join('\n\n')
      sendText(res, 200, txt, 'text/plain', `playground-runs-${files.length}.txt`)
    } else {
      sendText(res, 200, JSON.stringify(files.length === 1 ? files[0] : files, null, 2), 'application/json', `playground-run${files.length === 1 ? `-${files[0]!.run.runId}` : 's'}.json`)
    }
    return true
  }

  // POST /api/playground/import
  if (p === '/api/playground/import' && method === 'POST') {
    const body = await readBody(req)
    const imported: string[] = []
    let formats: string[] = []
    let skipped = 0

    // Native hwt envelopes first (validated), then external formats.
    let native: PlaygroundRunFile[] | null = null
    try {
      native = parseEnvelopes(body)
    } catch (err) {
      if ((err as Error).message !== 'NO_NATIVE_ENVELOPE') {
        send(res, 400, { ok: false, error: `import parse failed: ${(err as Error).message}` })
        return true
      }
    }

    if (native) {
      for (const env of native) {
        const problem = validateEnvelope(env)
        if (problem) {
          send(res, 400, { ok: false, error: problem, imported })
          return true
        }
        imported.push(importRun({ run: env.run, events: env.events ?? [] }))
      }
      formats = native.map(() => 'hwt')
    } else {
      let external
      try {
        external = parseExternalImport(body)
      } catch (err) {
        send(res, 400, { ok: false, error: `import parse failed: ${(err as Error).message}` })
        return true
      }
      for (const item of external.items) imported.push(importRun(item))
      formats = external.formats
      skipped = external.skipped
    }

    send(res, 200, { ok: true, imported, formats, skipped })
    return true
  }

  const runMatch = p.match(/^\/api\/playground\/runs\/([^/]+)(\/export|\/fork)?$/)
  if (runMatch && method === 'GET') {
    const runId = decodeURIComponent(runMatch[1]!)
    const detail = getRunDetail(runId)
    if (!detail) {
      send(res, 404, { ok: false, error: `run not found: ${runId}` })
      return true
    }
    if (runMatch[2] === '/export') {
      const format = url.searchParams.get('format') ?? 'json'
      const env = envelopeFor(runId)
      if ('error' in env) {
        send(res, 404, { ok: false, error: env.error })
        return true
      }
      if (format === 'txt') {
        sendText(res, 200, renderRunTxt(env.run, env.events), 'text/plain', `playground-run-${runId}.txt`)
      } else {
        sendText(res, 200, JSON.stringify(env, null, 2), 'application/json', `playground-run-${runId}.json`)
      }
      return true
    }
    if (!runMatch[2]) {
      send(res, 200, withRouge(detail))
      return true
    }
  }

  // DELETE /api/playground/runs/:id — drop one run and its trajectory/verdicts.
  // Single-run only: a bulk wipe would take the C0 reference out from under the
  // lift calculation in computeLiveMetrics(), silently rewriting every other
  // config's comparison rather than removing one row.
  const deleteMatch = p.match(/^\/api\/playground\/runs\/([^/]+)$/)
  if (deleteMatch && method === 'DELETE') {
    const out = deleteRun(decodeURIComponent(deleteMatch[1]!))
    if (out.reason === 'not-found') {
      send(res, 404, { ok: false, error: `run not found: ${out.runId}` })
      return true
    }
    if (out.reason === 'in-flight') {
      send(res, 409, { ok: false, error: 'run is still queued or running' })
      return true
    }
    send(res, 200, { ok: true, ...out })
    return true
  }

  // POST /api/playground/runs/:id/fork — rerun same task from a frozen config,
  // optionally overriding config fields / model.
  const forkMatch = p.match(/^\/api\/playground\/runs\/([^/]+)\/fork$/)
  if (forkMatch && method === 'POST') {
    const src = getRunDetail(decodeURIComponent(forkMatch[1]!))
    if (!src) {
      send(res, 404, { ok: false, error: 'run not found' })
      return true
    }
    const task = getTask(src.taskId)
    if (!task) {
      send(res, 404, { ok: false, error: `task not found: ${src.taskId}` })
      return true
    }
    const body = JSON.parse(await readBody(req)) as {
      config?: Partial<HarnessConfig>
      mounts?: typeof src.mounts
      providerId?: string
      model?: string
      temperature?: number
      seed?: number
      maxTokens?: number
    }
    const made = createRun({
      task,
      config: body.config ? ({ ...src.config, ...body.config } as HarnessConfig) : src.config,
      mounts: body.mounts ?? src.mounts,
      presetId: src.presetId,
      providerId: body.providerId,
      model: body.model,
      temperature: body.temperature ?? src.temperature ?? undefined,
      seed: body.seed ?? src.seed ?? undefined,
      maxTokens: body.maxTokens ?? src.maxTokens ?? undefined,
    })
    if ('error' in made) {
      send(res, 400, { ok: false, error: made.error })
      return true
    }
    enqueueRun(made.runId)
    send(res, 202, { ok: true, created: made, forkedFrom: src.runId })
    return true
  }

  // POST /api/playground/runs/:id/rescore — link an imported run to a real eval
  // task and score its answer with our own scorer. Until this succeeds the run
  // stays unlinked and excluded from every aggregate.
  const rescoreMatch = p.match(/^\/api\/playground\/runs\/([^/]+)\/rescore$/)
  if (rescoreMatch && method === 'POST') {
    const runId = decodeURIComponent(rescoreMatch[1]!)
    const detail = getRunDetail(runId)
    if (!detail) {
      send(res, 404, { ok: false, error: 'run not found' })
      return true
    }
    let body: { taskId?: string }
    try {
      body = JSON.parse(await readBody(req)) as { taskId?: string }
    } catch {
      send(res, 400, { ok: false, error: 'request body is not valid JSON' })
      return true
    }
    const task = getTask(body.taskId ?? '')
    if (!task) {
      send(res, 404, { ok: false, error: `task not found: ${body.taskId ?? ''}` })
      return true
    }
    const answer = detail.answer ?? ''
    if (!answer.trim()) {
      send(res, 400, { ok: false, error: 'this imported run has no final answer to score' })
      return true
    }
    const verdict = scoreAnswer(task, answer)
    relinkRun(runId, { id: task.id, title: task.title, domain: task.domain, split: task.split }, verdict)
    send(res, 200, { ok: true, run: getRunDetail(runId) })
    return true
  }

  // ── M4 evolution (PRISM) ─────────────────────────────────────────────────
  // GET /api/playground/evolve — clusters, cards, generations, mutations
  if (p === '/api/playground/evolve' && method === 'GET') {
    send(res, 200, { ok: true, ...getEvoState() })
    return true
  }

  // POST /api/playground/evolve — cluster + route + propose cards
  if (p === '/api/playground/evolve' && method === 'POST') {
    let body: { runIds?: string[] }
    try {
      body = JSON.parse(await readBody(req)) as { runIds?: string[] }
    } catch {
      send(res, 400, { ok: false, error: 'request body is not valid JSON' })
      return true
    }
    const analysis = await analyze(Array.isArray(body.runIds) ? body.runIds : undefined)
    send(res, 200, { ok: true, ...analysis, state: getEvoState() })
    return true
  }

  // POST /api/playground/cards/:id/apply — falsify + approve + new version
  const applyMatch = p.match(/^\/api\/playground\/cards\/([^/]+)\/apply$/)
  if (applyMatch && method === 'POST') {
    const cardId = decodeURIComponent(applyMatch[1]!)
    let body: { mode?: 'manual' | 'auto'; autonomyLevel?: number }
    try {
      body = JSON.parse(await readBody(req)) as { mode?: 'manual' | 'auto'; autonomyLevel?: number }
    } catch {
      send(res, 400, { ok: false, error: 'request body is not valid JSON' })
      return true
    }
    const result = await applyCard(cardId, {
      mode: body.mode === 'auto' ? 'auto' : 'manual',
      autonomyLevel: body.autonomyLevel ?? 0,
    })
    send(res, result.started ? 202 : result.ok ? 200 : 422, { ...result, state: getEvoState() })
    return true
  }

  // POST /api/playground/generations/:id/rollback — repoint current version
  const rollbackMatch = p.match(/^\/api\/playground\/generations\/([^/]+)\/rollback$/)
  if (rollbackMatch && method === 'POST') {
    const generationId = decodeURIComponent(rollbackMatch[1]!)
    const out = rollbackTo(generationId)
    send(res, out.ok ? 200 : 404, { ...out, state: getEvoState() })
    return true
  }

  // POST /api/playground/mutations/:commitId/gate — §7.2④ held-out gate verify
  // Body may carry §3.2 repeats / temperature; omitted → derived from temperature.
  const gateMatch = p.match(/^\/api\/playground\/mutations\/([^/]+)\/gate$/)
  if (gateMatch && method === 'POST') {
    const commitId = decodeURIComponent(gateMatch[1]!)
    let body: { repeats?: number; temperature?: number } = {}
    try {
      body = JSON.parse(await readBody(req)) as { repeats?: number; temperature?: number }
    } catch {
      body = {}
    }
    const out = startGateVerify(commitId, {
      repeats: typeof body.repeats === 'number' ? body.repeats : undefined,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    })
    send(res, out.ok ? 202 : 422, { ...out, state: getEvoState() })
    return true
  }

  // POST /api/playground/evolve/race — §7.2④ top-N side-by-side Pareto race
  if (p === '/api/playground/evolve/race' && method === 'POST') {
    let body: { autonomyLevel?: number; topN?: number; repeats?: number } = {}
    try {
      body = JSON.parse(await readBody(req)) as { autonomyLevel?: number; topN?: number; repeats?: number }
    } catch {
      body = {}
    }
    const out = startTopRace({
      autonomyLevel: body.autonomyLevel ?? 0,
      topN: typeof body.topN === 'number' ? body.topN : undefined,
      repeats: typeof body.repeats === 'number' ? body.repeats : undefined,
    })
    send(res, out.ok ? 202 : 422, { ...out, state: getEvoState() })
    return true
  }

  // POST /api/playground/evolve/auto — continuous auto-evolution loop
  if (p === '/api/playground/evolve/auto' && method === 'POST') {
    let body: { autonomyLevel?: number }
    try {
      body = JSON.parse(await readBody(req)) as { autonomyLevel?: number }
    } catch {
      body = {}
    }
    const out = startAutoEvolve(body.autonomyLevel ?? 0)
    send(res, out.ok ? 202 : 422, { ...out, state: getEvoState() })
    return true
  }

  return false
}
