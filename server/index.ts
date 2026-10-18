// stdlib http server: fixture API + SSE deterministic replay (:4000)
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { hasData, listScenarios, metricsForConfig, resolveReplay, getMetrics, getScenario } from './replayer'
import { deleteSetting, getSetting, getSettings, putProviderBundle, putSetting } from './settingsStore'
import { getModelCatalog } from './providers/model-capabilities-registry'
import { filterChatModels, filterModelInfosForProvider, filterModelsForProvider } from '../shared/modelFilter'
import { PRESETS } from '../shared/presets'
import type { HarnessConfig } from '../shared/config'
import { parseClaudeCodeTranscript } from './importers/claudeCode'
import { parseDshTrajectory } from './importers/dshTrajectory'
import { parsePlaygroundRun } from './importers/playgroundRun'
import { exportNlah, importNlah } from './importers/nlah'
import { handleRetrievalRoute, handleSearchApiRoute } from './knowledge/routes'
import { handlePlaygroundRoute } from './playground/routes'
import { verifyJevTarget } from './playground/jevClient'
import { recoverQueuedRuns } from './playground/runner'
import { recoverStuckCards } from './playground/evolve'
import { isDecisionProvider } from '../shared/provider'
import { JEV_MODEL_IDS, JEV_OPENCODE_MODEL_IDS, JEV_PROVIDER_ID_OPENCODE, JEV_PROVIDER_ID_OPENROUTER } from '../shared/jev'

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

    // ---- Knowledge base / retrieval settings / Search API (patentExaminator port) ----
    if (
      p.startsWith('/api/retrieval/') ||
      p.startsWith('/api/knowledge/') ||
      p.startsWith('/api/search') ||
      p === '/api/verify-search-key'
    ) {
      void (async () => {
        try {
          const handled =
            (await handleRetrievalRoute(req, res, p, req.method)) || (await handleSearchApiRoute(req, res, p, req.method))
          if (!handled) json(res, 404, { ok: false, error: `no route: ${p}` })
        } catch (err) {
          try {
            json(res, 500, { ok: false, error: String((err as Error).message ?? err) })
          } catch { /* socket gone */ }
        }
      })()
      return
    }

    // ---- Live Playground (patent judicial-review scenario; M1 eval set + scorer) ----
    if (p.startsWith('/api/playground/')) {
      void (async () => {
        try {
          const handled = await handlePlaygroundRoute(req, res, p, req.method)
          if (!handled) json(res, 404, { ok: false, error: `no route: ${p}` })
        } catch (err) {
          try {
            json(res, 500, { ok: false, error: String((err as Error).message ?? err) })
          } catch { /* socket gone */ }
        }
      })()
      return
    }

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
      // 静态目录也过滤：设置屏的模型下拉与元数据都用它
      const full = getModelCatalog()
      const catalog = Object.fromEntries(
        Object.entries(full).map(([pid, list]) => [pid, filterModelInfosForProvider(pid, list)]),
      )
      return json(res, 200, { ok: true, catalog })
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
            const { providers, enableProviderFallback, enableDecisionProviderFallback } = bodyJson<{
              providers?: unknown; enableProviderFallback?: boolean; enableDecisionProviderFallback?: boolean
            }>(raw)
            if (!Array.isArray(providers)) return json(res, 400, { ok: false, error: 'providers must be an array' })
            putProviderBundle(providers as Array<Record<string, unknown>>, { enableProviderFallback, enableDecisionProviderFallback })
            return json(res, 200, { ok: true })
          }
          if (provMatch) {
            const providerId = decodeURIComponent(provMatch[1])
            const action = provMatch[2]
            const { apiKey, baseUrl, modelId } = bodyJson<{ apiKey?: string; baseUrl?: string; modelId?: string }>(raw)
            if (!apiKey) return json(res, 400, { ok: false, error: 'apiKey is required' })
            const base = (baseUrl || '').trim().replace(/\/+$/, '')
            if (!base) return json(res, 400, { ok: false, error: 'baseUrl is required' })
            // 判定模型卡（TypeSafe Jev / OpenCode Jev / OpenRouter 判定）：没有 OpenAI 兼容的
            // /chat/completions，主调用与「验证」都走 System One 探针（POST {base}/systemone）。
            // 「查询模型」分两种：
            //   · TypeSafe / OpenCode 两张托管卡没有 /models 端点 → 回静态托管型号清单；
            //   · OpenRouter 判定卡是普通 OpenAI 兼容端点 → 落到下面的通用 /models 实时查询，
            //     再由 filterModelsForProvider 按判定型号白名单过滤（shared/modelFilter.ts）。
            if (isDecisionProvider(providerId)) {
              if (action === 'models' && providerId !== JEV_PROVIDER_ID_OPENROUTER) {
                const staticModels = providerId === JEV_PROVIDER_ID_OPENCODE ? JEV_OPENCODE_MODEL_IDS : JEV_MODEL_IDS
                return json(res, 200, {
                  ok: true,
                  providerId,
                  models: [...staticModels],
                  source: 'static',
                  note: '判定模型没有 /models 端点，返回托管型号清单',
                })
              }
              if (action === 'verify-model') {
                if (!modelId) return json(res, 400, { ok: false, error: 'apiKey and modelId are required' })
                const probe = await verifyJevTarget({ providerId, baseUrl: base, apiKey, model: modelId })
                return json(res, 200, probe.ok ? { ok: true, modelId, latencyMs: probe.latencyMs } : { ok: false, modelId, error: probe.error })
              }
            }
            try {
              if (action === 'models') {
                // 判定卡要打带 output_modalities=decisions 的那个清单：OpenRouter 的普通 /models
                // **不返回**判定型号（2026-10-12 实测 458 条里一个都没有），过滤普通清单只会得到空列表。
                const query = providerId === JEV_PROVIDER_ID_OPENROUTER ? '?output_modalities=decisions' : ''
                // Generic OpenAI-compatible model listing (docStudio uses per-provider adapters).
                const r = await fetch(`${base}/models${query}`, {
                  headers: { Authorization: `Bearer ${apiKey}` },
                  signal: AbortSignal.timeout(15_000),
                })
                if (!r.ok) return json(res, 502, { ok: false, error: `HTTP ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}` })
                const data = await r.json() as { data?: { id?: string }[] }
                const all = Array.isArray(data.data) ? data.data.map((m) => m.id).filter((x): x is string => typeof x === 'string') : []
                // 只回可选模型：判定卡走判定型号白名单；其余卡先过品类（厂商会把 embedding / rerank /
                // 语音 / 图像一并返回，百炼一次 262 条），有免费档的厂商再只留免费档。
                const models = filterModelsForProvider(providerId, all)
                return json(res, 200, { ok: true, providerId, models, filteredOut: all.length - models.length })
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
            if (format === 'hwt') return json(res, 200, parsePlaygroundRun(text))
            return json(res, 400, { error: 'unknown format (want claude|dsh|hwt)' })
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
  // 队列在内存里：重启会静默丢掉所有排队中的实跑（行永远卡在 queued）。启动时补回。
  try {
    recoverQueuedRuns()
  } catch (err) {
    console.warn('[server] 恢复排队实跑失败：', String((err as Error).message ?? err))
  }
  // Same trap one level up: a card left in `screening` was being falsified by a
  // detached worker that died with this process. Nothing will ever move it again,
  // and applyCard refuses to touch a `screening` card — so the button would be
  // dead until someone hand-edits the row.
  try {
    recoverStuckCards()
  } catch (err) {
    console.warn('[server] 恢复卡住的证伪失败：', String((err as Error).message ?? err))
  }
})
