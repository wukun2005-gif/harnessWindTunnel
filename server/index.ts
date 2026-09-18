// stdlib http server: fixture API + SSE deterministic replay (:4000)
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getMetrics, getScenario, hasData, listScenarios, metricsForConfig, resolveReplay } from './replayer'
import { PRESETS } from '../shared/presets'
import type { HarnessConfig } from '../shared/config'

const PORT = 4000

function json(res: import('node:http').ServerResponse, code: number, body: unknown) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(s)
}

function parseConfig(raw: string | null): HarnessConfig | undefined {
  if (!raw) return undefined
  return JSON.parse(raw) as HarnessConfig
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

    return json(res, 404, { error: `no route: ${p}` })
  } catch (err) {
    return json(res, 400, { error: String((err as Error).message ?? err) })
  }
})

server.listen(PORT, () => {
  console.log(`[server] HarnessWindTunnel API on http://localhost:${PORT} (data: ${hasData() ? 'ready' : 'MISSING — run npm run gen:fixtures'})`)
})
