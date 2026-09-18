// stdlib http server: fixture API + SSE deterministic replay (:4000)
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getMetrics, getScenario, hasData, listScenarios, metricsForConfig, resolveReplay } from './replayer'
import { PRESETS } from '../shared/presets'
import type { HarnessConfig } from '../shared/config'
import { parseClaudeCodeTranscript } from './importers/claudeCode'
import { parseDshTrajectory } from './importers/dshTrajectory'
import { exportNlah, importNlah } from './importers/nlah'
import { hasKey, setKey } from './keyStore'
import { VENDOR_PRESETS } from '../shared/provider'

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

    if (p === '/api/provider-key-status') {
      const id = q.get('id') ?? ''
      return json(res, 200, { hasKey: hasKey(id) })
    }

    if (req.method === 'POST' && (p === '/api/import' || p === '/api/nlah/export' || p === '/api/nlah/import' || p === '/api/provider-key' || p === '/api/provider-models')) {
      void readBody(req).then((raw) => {
        try {
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
          if (p === '/api/provider-key') {
            const { id, apiKey } = bodyJson<{ id?: string; apiKey?: string }>(raw)
            if (!id) return json(res, 400, { error: 'need provider id' })
            const ref = setKey(id, typeof apiKey === 'string' ? apiKey : '')
            return json(res, 200, { ok: true, ref, hasKey: hasKey(id) })
          }
          // Fake model listing for demo (simulated): matches a known vendor
          // baseUrl or falls back to a custom placeholder. Real /models
          // forwarding happens only against a user-configured live endpoint.
          const { baseUrl } = bodyJson<{ baseUrl?: string }>(raw)
          const norm = (baseUrl ?? '').trim().replace(/\/+$/, '')
          if (!norm) return json(res, 400, { error: 'need baseUrl' })
          const preset = VENDOR_PRESETS.find((v) => v.baseUrl.replace(/\/+$/, '') === norm)
          return json(res, 200, { models: preset ? preset.models : ['custom-model'], simulated: true })
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
