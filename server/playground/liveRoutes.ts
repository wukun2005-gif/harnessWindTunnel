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
import { PRESET_PROVIDERS } from '../../shared/provider'
import { getTask, loadEvalSet } from './evalset'
import { PG_PRESETS, resolveConfig } from './presets'
import { computeLiveMetrics } from './metrics'
import { renderRunTxt } from './exportFormat'
import { getRunDetail, importRun, listRuns } from './liveDb'
import { createRun, enqueueRun } from './runner'

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
  const detail = getRunDetail(runId)
  if (!detail) return { error: `run not found: ${runId}` }
  const { events, ...run } = detail
  return {
    kind: 'hwt-playground-run',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    run,
    events,
  }
}

function parseEnvelopes(raw: string): PlaygroundRunFile[] {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('空文件')
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed) as PlaygroundRunFile[]
    if (!Array.isArray(arr)) throw new Error('JSON 数组格式不正确')
    return arr
  }
  if (!trimmed.startsWith('{')) throw new Error('仅支持 JSON / JSONL 导入（TXT 为只读报告格式）')
  // Single JSON object, or JSONL (one envelope per line).
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length === 1) return [JSON.parse(lines[0]!) as PlaygroundRunFile]
  return lines.map((l) => JSON.parse(l) as PlaygroundRunFile)
}

function validateEnvelope(env: PlaygroundRunFile): string | null {
  if (!env || env.kind !== 'hwt-playground-run') return '缺少 kind=hwt-playground-run'
  if (env.schemaVersion !== 1) return `不支持的 schemaVersion：${String(env.schemaVersion)}`
  if (!env.run?.runId || !env.run?.taskId) return 'run 缺少 runId/taskId'
  for (const ev of env.events ?? []) {
    const parsed = eventSchema.safeParse(ev)
    if (!parsed.success) return `事件 ${(ev as { id?: string }).id ?? '?'} 校验失败：${parsed.error.issues[0]?.message ?? 'invalid event'}`
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
      send(res, 400, { ok: false, error: 'taskIds 不能为空' })
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
    let envelopes: PlaygroundRunFile[]
    try {
      envelopes = parseEnvelopes(await readBody(req))
    } catch (err) {
      send(res, 400, { ok: false, error: `导入解析失败：${(err as Error).message}` })
      return true
    }
    const imported: string[] = []
    for (const env of envelopes) {
      const problem = validateEnvelope(env)
      if (problem) {
        send(res, 400, { ok: false, error: problem, imported })
        return true
      }
      imported.push(importRun({ run: env.run, events: env.events ?? [] }))
    }
    send(res, 200, { ok: true, imported })
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
      if (format === 'txt') {
        sendText(res, 200, renderRunTxt(detail, detail.events), 'text/plain', `playground-run-${runId}.txt`)
      } else {
        const { events, ...run } = detail
        const env: PlaygroundRunFile = { kind: 'hwt-playground-run', schemaVersion: 1, exportedAt: new Date().toISOString(), run, events }
        sendText(res, 200, JSON.stringify(env, null, 2), 'application/json', `playground-run-${runId}.json`)
      }
      return true
    }
    if (!runMatch[2]) {
      send(res, 200, detail)
      return true
    }
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

  return false
}
