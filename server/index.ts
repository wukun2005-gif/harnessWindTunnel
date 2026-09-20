// stdlib http server: fixture API + SSE deterministic replay (:4000)
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hasData, listScenarios, metricsForConfig, resolveReplay, getMetrics, getScenario } from './replayer'
import { deleteSetting, getSetting, getSettings, putProviderBundle, putSetting } from './settingsStore'
import { getModelCatalog } from './providers/model-capabilities-registry'
import { PRESETS } from '../shared/presets'
import type { HarnessConfig } from '../shared/config'
import { parseClaudeCodeTranscript } from './importers/claudeCode'
import { parseDshTrajectory } from './importers/dshTrajectory'
import { exportNlah, importNlah } from './importers/nlah'

const PORT = Number(process.env['PORT'] ?? 4000)

function json(res: import('node:http').ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(s)
}

function parseConfig(raw: string | null): HarnessConfig | undefined {
  if (!raw) return undefined
  return JSON.parse(raw) as HarnessConfig
}

function readBody(req: import('node:http').IncomingMessage, limit = 1_000_000): Promise<string> {
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

function bodyJson<T>(raw: string): T {
  return JSON.parse(raw) as T
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname
  const q = url.searchParams
  try {
    if (p === '/api/health') return json(res, 200, { ok: true, data: hasData() })

    if (p === '/api/scenarios') {
      return json(res, 200, listScenarios().map((s) => {
        const m = getScenario(s.scenarioId)
        return { scenarioId: m.scenarioId, family: m.family, familyLabel: m.familyLabel, task: m.task, model: m.model, traps: m.traps, branches: m.branches.map((b) => b.branchId) }
      }))
    }

    if (p.startsWith('/api/scenarios/')) {
      const id = decodeURIComponent(p.split('/')[3])
      return json(res, 200, getScenario(id))
    }

    if (p === '/api/replay.json') {
      const scenarioId = q.get('scenario')!
      const { meta, events } = resolveReplay(scenarioId, parseConfig(q.get('config')), q.get('branch') ?? undefined)
      return json(res, 200, { meta, events })
    }

    if (p === '/api/replay') {
      const scenarioId = q.get('scenario')!
      const { meta, events } = resolveReplay(scenarioId, parseConfig(q.get('config')), q.get('branch') ?? undefined)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      send('meta', meta)
      let i = 0
      const timer = setInterval(() => {
        // Push at a fixed cadence; content determinism is guaranteed by the fixture
        for (const _ of [0, 1, 2, 3]) {
          if (i >= events.length) {
            clearInterval(timer)
            send('done', { count: events.length })
            res.end()
            return
          }
          send('event', events[i++])
        }
      }, 8)
      req.on('close', () => clearInterval(timer))
      return
    }

    if (p === '/api/metrics') {
      const scenarioId = q.get('scenario')!
      const config = parseConfig(q.get('config'))
      if (config) return json(res, 200, metricsForConfig(scenarioId, config))
      return json(res, 200, getMetrics(scenarioId))
    }

    if (p === '/api/presets') return json(res, 200, { presets: PRESETS })

    if (p === '/api/adaptation') {
      const scenarioId = q.get('scenario')!
      try {
        const doc = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'adaptation.json'), 'utf8'))
        if (!doc || doc.scenarioId !== scenarioId) return json(res, 404, { error: `no adaptation data for ${scenarioId}` })
        return json(res, 200, doc)
      } catch {
        return json(res, 404, { error: `no adaptation data for ${scenarioId}` })
      }
    }

    if (p === '/api/forge') {
      return json(res, 200, JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'forge', 'generations.json'), 'utf8')))
    }

    if (p === '/api/import-sample') {
      const name = q.get('name')
      const file = name === 'claude' ? 'claude-sample.jsonl' : name === 'dsh' ? 'dsh-sample.json' : null
      if (!file) return json(res, 400, { error: 'unknown sample (want claude|dsh)' })
      return json(res, 200, { name, text: readFileSync(resolve(process.cwd(), 'data', 'imports', file), 'utf8') })
    }

    // ---- Settings store (mirrors docStudio user_settings semantics) ----
    if (p === '/api/settings' && req.method !== 'PUT' && req.method !== 'DELETE') {
      return json(res, 200, { ok: true, settings: getSettings() })
    }

    if (p.startsWith('/api/settings/') && req.method !== 'POST') {
      const key = decodeURIComponent(p.slice('/api/settings/'.length))
      if (req.method === 'PUT' || req.method === 'PATCH') {
        void readBody(req).then((raw) => {
          try {
            const { value } = bodyJson<{ value?: unknown }>(raw)
            putSetting(key, value)
            return json(res, 200, { ok: true })
          } catch (err) {
            return json(res, 400, { ok: false, error: String((err as Error).message ?? err) })
          }
        }).catch((err) => {
          try { return json(res, 400, { ok: false, error: String((err as Error).message ?? err) }) } catch { /* socket gone */ }
        })
        return
      }
      if (req.method === 'DELETE') {
        deleteSetting(key)
        return json(res, 200, { ok: true })
      }
      return json(res, 200, { ok: true, value: getSetting(key) })
    }

    if (p === '/api/providers/models') {
      return json(res, 200, { ok: true, catalog: getModelCatalog() })
    }

    if (p === '/api/legal') {
      try {
        const dossiers = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'domain', 'legal', 'dossiers.json'), 'utf8'))
        const staircase = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'domain', 'legal', 'staircase.json'), 'utf8'))
        return json(res, 200, { dossiers: dossiers.dossiers, staircase })
      } catch {
        return json(res, 404, { error: 'no legal bundle' })
      }
    }

    if (p === '/api/redteam') {
      try {
        const attacks = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'redteam', 'attacks.json'), 'utf8'))
        const controls = JSON.parse(readFileSync(resolve(process.cwd(), 'data', 'redteam', 'controls.json'), 'utf8'))
        return json(res, 200, { attacks: attacks.cases, controls })
      } catch {
        return json(res, 404, { error: 'no redteam bundle' })
      }
    }

    const provMatch = p.match(/^\/api\/providers\/([^/]+)\/(models|verify-model)$/)
    if (req.method === 'POST' && (p === '/api/import' || p === '/api/nlah/export' || p === '/api/nlah/import' || p === '/api/settings/providers' || provMatch)) {
      void readBody(req).then(async (raw) => {
        try {
          if (p === '/api/settings/providers') {
            const { providers, enableProviderFallback } = bodyJson<{ providers?: unknown; enableProviderFallback?: boolean }>(raw)
            if (!Array.isArray(providers)) return json(res, 400, { ok: false, error: 'providers must be an array' })
            putProviderBundle(providers as Array<Record<string, unknown>>, { enableProviderFallback })
            return json(res, 200, { ok: true })
          }
          if (provMatch) {
            const providerId = decodeURIComponent(provMatch[1])
            const action = provMatch[2]
            const { apiKey, baseUrl, modelId } = bodyJson<{ apiKey?: string; baseUrl?: string; modelId?: string }>(raw)
            if (!apiKey) return json(res, 400, { ok: false, error: 'apiKey is required' })
            const base = (baseUrl || '').trim().replace(/\/+$/, '')
            if (!base) return json(res, 400, { ok: false, error: 'baseUrl is required' })
            try {
              if (action === 'models') {
                // Generic OpenAI-compatible model listing (docStudio uses per-provider adapters).
                const r = await fetch(`${base}/models`, {
                  headers: { Authorization: `Bearer ${apiKey}` },
                  signal: AbortSignal.timeout(15_000),
                })
                if (!r.ok) return json(res, 502, { ok: false, error: `HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` })
                const data = await r.json() as { data?: { id?: string }[] }
                const models = Array.isArray(data.data) ? data.data.map((m) => m.id).filter((x): x is string => typeof x === 'string') : []
                return json(res, 200, { ok: true, providerId, models })
              }
              if (!modelId) return json(res, 400, { ok: false, error: 'apiKey and modelId are required' })
              const fetchRes = await fetch(`${base}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
                signal: AbortSignal.timeout(10_000),
              })
              if (fetchRes.ok) return json(res, 200, { ok: true, modelId })
              const body = await fetchRes.text().catch(() => '')
              return json(res, 200, { ok: false, modelId, error: `HTTP ${fetchRes.status}: ${body.slice(0, 200)}` })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (action === 'models') return json(res, 502, { ok: false, error: message })
              return json(res, 200, { ok: false, modelId, error: message })
            }
          }
          if (p === '/api/import') {
            const { format, text } = bodyJson<{ format?: string; text?: string }>(raw)
            if (typeof text !== 'string' || !text.trim()) return json(res, 400, { error: 'missing text' })
            if (format === 'claude') return json(res, 200, parseClaudeCodeTranscript(text))
            if (format === 'dsh') {
              let doc: unknown
              try {
                doc = JSON.parse(text)
              } catch {
                return json(res, 400, { error: 'dsh text must be JSON' })
              }
              return json(res, 200, parseDshTrajectory(doc))
            }
            return json(res, 400, { error: 'unknown format (want claude|dsh)' })
          }
          if (p === '/api/nlah/export') {
            const { config, task } = bodyJson<{ config?: HarnessConfig; task?: string }>(raw)
            if (!config || typeof task !== 'string') return json(res, 400, { error: 'need config + task' })
            return json(res, 200, exportNlah(config, task))
          }
          const { doc } = bodyJson<{ doc?: unknown }>(raw)
          if (p === '/api/nlah/import') return json(res, 200, importNlah(doc))
          return json(res, 404, { ok: false, error: `no route: ${p}` })
        } catch (err) {
          return json(res, 400, { error: String((err as Error).message ?? err) })
        }
      }).catch((err) => {
        try {
          return json(res, 400, { error: String((err as Error).message ?? err) })
        } catch { /* socket already gone */ }
      })
      return
    }

    return json(res, 404, { error: `no route: ${p}` })
  } catch (err) {
    return json(res, 400, { error: String((err as Error).message ?? err) })
  }
})

server.listen(PORT, () => {
  console.log(`[server] HarnessWindTunnel API on http://localhost:${PORT} (data: ${hasData() ? 'ready' : 'MISSING — run npm run gen:fixtures'})`)
})
