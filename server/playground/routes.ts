// HTTP routes for the live Playground screen (M1). Mounted under /api/playground.
// M1 exposes the eval set, gold samples and the deterministic scorer only —
// no live LLM run, no metrics dashboard (those land in M2/M3).
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { loadEvalSet, getTask } from './evalset'
import { scoreAnswer, makeBadAnswer } from './scorer'
import { handleLiveRoute } from './liveRoutes'
import { getJevSettings, jevSettingsView, putJevSettings } from './jevSettings'
import { clearReviews, listReviews, saveReview } from './jevReviews'
import { jevLog } from './jevLog'
import { getAssertionTask, loadAssertionSet, runAssertionJudge } from './assertionJudge'
import { getTagTask, loadTagSet, runTagJudge } from './tagJudge'
import { getRagTask, loadRagSet, runRagJudge } from './ragJudge'
import { runJevJudge } from './jevJudge'
import { isJevScenario, liveRunJevScenario, thresholdForScenario, type JevScenario, type JevSettingsPatch } from '../../shared/jev'

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit = 2_000_000): Promise<string> {
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

export async function handlePlaygroundRoute(
  req: IncomingMessage,
  res: ServerResponse,
  p: string,
  method: string | undefined,
): Promise<boolean> {
  // GET /api/playground/tasks
  if (p === '/api/playground/tasks' && method === 'GET') {
    send(res, 200, loadEvalSet())
    return true
  }

  const taskMatch = p.match(/^\/api\/playground\/tasks\/([^/]+)(\/sample)?$/)
  if (taskMatch) {
    const id = decodeURIComponent(taskMatch[1]!)
    const task = getTask(id)
    if (!task) {
      send(res, 404, { ok: false, error: `task not found: ${id}` })
      return true
    }

    // GET /api/playground/tasks/:id/sample?kind=good|bad
    if (taskMatch[2] === '/sample' && method === 'GET') {
      const kind = (new URL(req.url ?? '/', 'http://localhost').searchParams.get('kind') ?? 'good') as 'good' | 'bad'
      const answer = kind === 'bad' ? makeBadAnswer(task) : task.referenceAnswer
      send(res, 200, { taskId: id, kind, answer })
      return true
    }

    // GET /api/playground/tasks/:id
    if (!taskMatch[2] && method === 'GET') {
      send(res, 200, task)
      return true
    }
  }

  // POST /api/playground/score  { taskId, answer }
  if (p === '/api/playground/score' && method === 'POST') {
    const raw = await readBody(req)
    const body = JSON.parse(raw) as { taskId?: string; answer?: string }
    const task = body.taskId ? getTask(body.taskId) : undefined
    if (!task) {
      send(res, 404, { ok: false, error: `task not found: ${body.taskId ?? ''}` })
      return true
    }
    const answer = typeof body.answer === 'string' ? body.answer : ''
    send(res, 200, scoreAnswer(task, answer))
    return true
  }

  // ── Jev 判定器开关 + 判分旁路复核（M1） ──
  // 开关落 server-data/settings.json 的 playground_jev 行；关闭时下面这个 judge 路由
  // 一次都不出网（source='off'）。凭据/型号来自设置屏的 Jev 卡（provider_all）。
  if (p === '/api/playground/jev' && method === 'GET') {
    send(res, 200, { ok: true, settings: jevSettingsView() })
    return true
  }

  if (p === '/api/playground/jev' && (method === 'PUT' || method === 'POST')) {
    const body = JSON.parse(await readBody(req)) as JevSettingsPatch
    // 场景阈值逐项白名单：只认四个已知场景的数值，其余键丢弃（normalize 还会再夹一次范围）。
    const scenarioThresholds: Partial<Record<JevScenario, number>> = {}
    for (const [k, v] of Object.entries(body.scenarioThresholds ?? {})) {
      if (isJevScenario(k) && typeof v === 'number' && Number.isFinite(v)) scenarioThresholds[k] = v
    }
    putJevSettings({
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(typeof body.confidenceThreshold === 'number' ? { confidenceThreshold: body.confidenceThreshold } : {}),
      ...(Object.keys(scenarioThresholds).length > 0 ? { scenarioThresholds } : {}),
      ...(typeof body.cascadeToChatJudge === 'boolean' ? { cascadeToChatJudge: body.cascadeToChatJudge } : {}),
      ...(typeof body.chatJudgeAlways === 'boolean' ? { chatJudgeAlways: body.chatJudgeAlways } : {}),
    })
    send(res, 200, { ok: true, settings: jevSettingsView() })
    return true
  }

  if (p === '/api/playground/jev/judge' && method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { taskId?: string; answer?: string; batchId?: string; kind?: string; clean?: boolean }
    const task = body.taskId ? getTask(body.taskId) : undefined
    if (!task) {
      send(res, 404, { ok: false, error: `task not found: ${body.taskId ?? ''}` })
      return true
    }
    const answer = typeof body.answer === 'string' ? body.answer.slice(0, 200_000) : ''
    const batchId = typeof body.batchId === 'string' && body.batchId ? body.batchId : null
    const kind: 'good' | 'bad' | null = body.kind === 'good' || body.kind === 'bad' ? body.kind : null
    const clean = body.clean === true
    const result = await runJevJudge(task, answer, { batchId, clean })
    jevLog(
      `done task=${task.id} batch=${batchId ?? '-'}${clean ? ' clean' : ''} source=${result.source} latencyMs=${result.latencyMs ?? '-'}${result.error ? ` error=${result.error}` : ''}`,
    )
    // A/B 记录（§17.9）：开关关闭（off）不算一次复核，其余全落盘；落盘失败不影响判分返回。
    if (result.source !== 'off') {
      const det = scoreAnswer(task, answer)
      const s = getJevSettings()
      const rec = {
        id: randomUUID(),
        time: new Date().toISOString(),
        batchId,
        kind,
        variant: clean ? ('clean' as const) : null,
        taskId: task.id,
        domain: task.domain,
        split: task.split,
        scorerType: task.scorerType,
        answer,
        detSuccess: det.success,
        detScore: det.score,
        // 与 runJevJudge 内部同源：法律域任务用法律断言阈值，其余用通用实况风洞。
        threshold: thresholdForScenario(s, liveRunJevScenario(task.domain)),
        cascadeEnabled: s.cascadeToChatJudge,
        result,
      }
      saveReview(rec)
      jevLog(`saved review id=${rec.id} task=${task.id} batch=${batchId ?? '-'}${clean ? ' clean' : ''}`)
    }
    send(res, 200, result)
    return true
  }

  // GET /api/playground/jev/reviews?task=&domain=&batch=&from=&to=&limit= — 分析视图数据源（§17.9）。
  if (p === '/api/playground/jev/reviews' && method === 'GET') {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams
    const limitRaw = Number(q.get('limit') ?? '')
    const out = listReviews({
      task: q.get('task') ?? undefined,
      domain: q.get('domain') ?? undefined,
      batch: q.get('batch') ?? undefined,
      from: q.get('from') ?? undefined,
      to: q.get('to') ?? undefined,
      limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
    })
    jevLog(`list reviews task=${q.get('task') ?? '-'} domain=${q.get('domain') ?? '-'} batch=${q.get('batch') ?? '-'} → ${out.length}`)
    send(res, 200, out)
    return true
  }

  // DELETE /api/playground/jev/reviews?batchId=… | ?all=true — 清除失败批次后重跑（§17.9）。
  if (p === '/api/playground/jev/reviews' && method === 'DELETE') {
    const q = new URL(req.url ?? '/', 'http://localhost').searchParams
    const batchId = q.get('batchId') ?? undefined
    const all = q.get('all') === 'true'
    if (!batchId && !all) {
      send(res, 400, { ok: false, error: 'missing batchId or all=true' })
      return true
    }
    const deleted = clearReviews({ batchId, all })
    jevLog(`cleared reviews batch=${batchId ?? '-'} all=${all} deleted=${deleted}`)
    send(res, 200, { ok: true, deleted })
    return true
  }

  // ── P0-A 法律断言判定（M1 场景扩展）：题集 + 单条复核（记录进同一 A/B 存储）。
  // GET /api/playground/assertions/tasks
  if (p === '/api/playground/assertions/tasks' && method === 'GET') {
    send(res, 200, { total: loadAssertionSet().length, tasks: loadAssertionSet() })
    return true
  }

  // POST /api/playground/assertions/judge { assertionId, kind, batchId? }
  if (p === '/api/playground/assertions/judge' && method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { assertionId?: string; kind?: string; batchId?: string }
    const task = body.assertionId ? getAssertionTask(body.assertionId) : undefined
    if (!task) {
      send(res, 404, { ok: false, error: `assertion not found: ${body.assertionId ?? ''}` })
      return true
    }
    const kind: 'good' | 'bad' = body.kind === 'bad' ? 'bad' : 'good'
    const answer = kind === 'bad' ? task.badAnswer : task.goodAnswer
    const batchId = typeof body.batchId === 'string' && body.batchId ? body.batchId : null
    const record = await runAssertionJudge(task, kind, answer, { batchId })
    if (record.result.source !== 'off') saveReview(record)
    send(res, 200, record)
    return true
  }

  // ── P1-C 失败标签断言（M1 场景扩展）：题集 + 单条复核（记录进同一 A/B 存储）。
  // GET /api/playground/tags/tasks
  if (p === '/api/playground/tags/tasks' && method === 'GET') {
    send(res, 200, { total: loadTagSet().length, tasks: loadTagSet() })
    return true
  }

  // POST /api/playground/tags/judge { tagId, kind, batchId? }
  if (p === '/api/playground/tags/judge' && method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { tagId?: string; kind?: string; batchId?: string }
    const task = body.tagId ? getTagTask(body.tagId) : undefined
    if (!task) {
      send(res, 404, { ok: false, error: `tag task not found: ${body.tagId ?? ''}` })
      return true
    }
    const kind: 'good' | 'bad' = body.kind === 'bad' ? 'bad' : 'good'
    const batchId = typeof body.batchId === 'string' && body.batchId ? body.batchId : null
    const record = await runTagJudge(task, kind, { batchId })
    if (record.result.source !== 'off') saveReview(record)
    send(res, 200, record)
    return true
  }

  // ── P1-E RAG 支撑度（C 页签一键全测用）：题集 + 单条复核（记录进同一 A/B 存储）。
  // GET /api/playground/rag/tasks
  if (p === '/api/playground/rag/tasks' && method === 'GET') {
    send(res, 200, { total: loadRagSet().length, tasks: loadRagSet() })
    return true
  }

  // POST /api/playground/rag/judge { ragId, kind, batchId? }
  if (p === '/api/playground/rag/judge' && method === 'POST') {
    const body = JSON.parse(await readBody(req)) as { ragId?: string; kind?: string; batchId?: string }
    const task = body.ragId ? getRagTask(body.ragId) : undefined
    if (!task) {
      send(res, 404, { ok: false, error: `rag task not found: ${body.ragId ?? ''}` })
      return true
    }
    const kind: 'good' | 'bad' = body.kind === 'bad' ? 'bad' : 'good'
    const answer = kind === 'bad' ? task.badAnswer : task.goodAnswer
    const batchId = typeof body.batchId === 'string' && body.batchId ? body.batchId : null
    const record = await runRagJudge(task, kind, answer, { batchId })
    if (record.result.source !== 'off') saveReview(record)
    send(res, 200, record)
    return true
  }

  // M2 live runs, presets, targets, metrics, import/export, fork.
  if (await handleLiveRoute(req, res, p, method)) return true

  return false
}
