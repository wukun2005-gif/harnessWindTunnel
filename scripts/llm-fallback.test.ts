// 设置屏两级回退的离线单测：不打真实网络。
// 覆盖：① Provider 回退——开关开＝主服务商失败后按卡顺序切到下一个可用服务商（记真实应答方
// 与失败现场）；主服务商正常时不回退；开关关＝保持原错误且只用主模型；没有下一个可用服务商＝
// 原错误透出；全链失败＝错误带整条链；请求已中止＝不回退；判定模型卡永远不进 chat 目标与回退链。
// ② 模型回退（每张卡自己的开关＋列表，与 Provider 回退独立）——主模型失败后同服务商换模型
// （记真实应答模型与失败现场）；开关关＝列表再长也不用；同卡全败＝错误带模型粒度整条链；
// 两级联动（同卡模型用尽 → 下一服务商的模型链）；中止时不再试下一个模型。
// ③ 错误分类（照搬 patentExaminator 成熟机制）——401 鉴权失败＝整链停止原错误透出；403/429 配额
// ＝不换目标直接换模型；5xx/超时/网络＝同目标退避重试 2 次再换目标（本文件把退避压成 0ms）；
// 2xx 正文过不了 validate（内容级失败）＝该次尝试失败进回退链；模型级尝试封顶 8 次；
// 单请求超时按可重试类处理；单目标单模型的原始错误仍逐字透出。
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JEV_PROVIDER_ID } from '../shared/jev'
import { chatCompletionWithFallback, resolveChatTarget, resolveChatTargets } from '../server/playground/llmClient'
import { putProviderBundle } from '../server/settingsStore'

process.env['HWT_SETTINGS_FILE'] = join(mkdtempSync(join(tmpdir(), 'hwt-pfb-')), 'settings.json')
// 5xx/超时/网络的同目标退避重试（500ms/1500ms）在测试里压成 0ms，语义保留、耗时归零。
process.env['HWT_FB_BACKOFF_MS'] = '0,0'

// ── 假 HTTP 层：真实 fetch 被替换，测试结束后还原 ──────────────────────────

const realFetch = globalThis.fetch
let calls: Array<{ url: string; model: string }> = []
let respond: (model: string, init?: RequestInit) => Response | Promise<Response> = () => chatOk('ok')

function chatOk(text: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url)
  const model = init?.body ? String(JSON.parse(String(init.body))['model'] ?? '') : ''
  calls.push({ url, model })
  if (init?.signal?.aborted) throw new DOMException('This operation was aborted', 'AbortError')
  return respond(model, init)
}) as typeof globalThis.fetch

after(() => {
  globalThis.fetch = realFetch
})

// ── 设置存储：两张 chat 卡 + 一张判定卡 ────────────────────────────────────

const DEEPSEEK = { providerId: 'deepseek', apiKey: 'k-ds', baseUrl: 'https://api.deepseek.com/v1', modelIds: ['deepseek-chat'], defaultModelId: 'deepseek-chat', enabled: true }
const KIMI = { providerId: 'kimi', apiKey: 'k-km', baseUrl: 'https://api.moonshot.cn/v1', modelIds: ['kimi-k2'], defaultModelId: 'kimi-k2', enabled: true }
const JEV_CARD = { providerId: JEV_PROVIDER_ID, apiKey: 'k-jev', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-1.13.0'], defaultModelId: 'jev-1.13.0', enabled: true }

const REQ = { messages: [{ role: 'user' as const, content: 'hi' }] }

function mustTarget() {
  const t = resolveChatTarget()
  assert.ok(!('error' in t), 'error' in t ? t.error : '')
  return t
}

test('回退开关打开：主服务商 HTTP 失败后自动切到下一个可用服务商', async () => {
  putProviderBundle([DEEPSEEK, KIMI, JEV_CARD], { enableProviderFallback: true })
  calls = []
  respond = (model) => (model === 'deepseek-chat' ? new Response('down', { status: 500 }) : chatOk('switched'))

  const res = await chatCompletionWithFallback(mustTarget(), REQ)
  assert.equal(res.text, 'switched')
  assert.equal(res.used.providerId, 'kimi')
  assert.equal(res.used.model, 'kimi-k2')
  assert.equal(res.switchedFrom?.providerId, 'deepseek')
  assert.equal(res.switchedFrom?.model, 'deepseek-chat')
  assert.ok(res.switchedFrom?.reason.includes('HTTP 500'))
  assert.equal(calls.length, 4) // 主卡同目标 5xx 退避重试共 3 次 + kimi 1 次
  assert.ok(calls[0]!.url.startsWith('https://api.deepseek.com/v1/chat/completions'))
  assert.ok(calls[3]!.url.startsWith('https://api.moonshot.cn/v1/chat/completions'))
  assert.equal(calls[3]!.model, 'kimi-k2')
})

test('主服务商正常时不回退，也不带 switchedFrom', async () => {
  putProviderBundle([DEEPSEEK, KIMI], { enableProviderFallback: true })
  calls = []
  respond = () => chatOk('fine')

  const res = await chatCompletionWithFallback(mustTarget(), REQ)
  assert.equal(res.used.providerId, 'deepseek')
  assert.equal(res.switchedFrom, undefined)
  assert.equal(calls.length, 1)
})

test('回退开关关闭：保持原错误（5xx 同目标退避重试后仍逐字透出原错误）', async () => {
  putProviderBundle([DEEPSEEK, KIMI], { enableProviderFallback: false })
  calls = []
  respond = () => new Response('down', { status: 500 })

  await assert.rejects(chatCompletionWithFallback(mustTarget(), REQ), /HTTP 500/)
  assert.equal(calls.length, 3) // 同目标 1 + 退避重试 2，不换模型不切服务商
})

test('没有下一个可用服务商（判定卡不算）：原错误透出', async () => {
  putProviderBundle([DEEPSEEK, JEV_CARD], { enableProviderFallback: true })
  calls = []
  respond = () => new Response('down', { status: 500 })

  await assert.rejects(chatCompletionWithFallback(mustTarget(), REQ), /HTTP 500/)
  assert.equal(calls.length, 3)
})

test('全链都失败：错误里带上整条链', async () => {
  putProviderBundle([DEEPSEEK, KIMI], { enableProviderFallback: true })
  calls = []
  respond = () => new Response('down', { status: 500 })

  await assert.rejects(
    chatCompletionWithFallback(mustTarget(), REQ),
    (e: unknown) => e instanceof Error
      && e.message.includes('所有可用服务商均失败')
      && e.message.includes('deepseek')
      && e.message.includes('kimi'),
  )
  assert.equal(calls.length, 6) // 2 张卡 × 1 模型 × 同目标 3 次
})

test('请求已中止：不回退，不再打第二个服务商', async () => {
  putProviderBundle([DEEPSEEK, KIMI], { enableProviderFallback: true })
  calls = []
  respond = () => chatOk('never reached')
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    chatCompletionWithFallback(mustTarget(), { ...REQ, signal: controller.signal }),
    /abort/i,
  )
  assert.equal(calls.length, 1)
})

test('判定模型卡永远不进 chat 目标与回退链', () => {
  putProviderBundle([DEEPSEEK, KIMI, JEV_CARD], { enableProviderFallback: true })
  const target = mustTarget()
  assert.equal(target.providerId, 'deepseek')

  const chain = resolveChatTargets({})
  assert.ok(!('error' in chain))
  assert.deepEqual(chain.targets.map((t) => t.providerId), ['deepseek', 'kimi'])

  // 只剩判定卡配置时，给出设置屏可操作的引导错误（而不是把 Jev 当 chat 目标）。
  putProviderBundle([JEV_CARD], { enableProviderFallback: true })
  const only = resolveChatTarget()
  assert.ok('error' in only)
  assert.ok(only.error.includes('#/settings'))
})

// ── 同卡模型回退（每张卡自己的「模型回退」开关＋列表；与 Provider 回退相互独立） ──────

const DS_MODEL_FB = {
  ...DEEPSEEK,
  enableModelFallback: true,
  // 列表头放当前默认模型是设置页的保存行为，必须去重——主模型不许被打第二次。
  modelFallbacks: ['deepseek-chat', 'deepseek-reasoner'],
}

test('模型回退开关打开：主模型失败后同服务商换模型，Provider 回退关也不受影响', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: false })
  calls = []
  respond = (model) => (model === 'deepseek-chat' ? new Response('quota', { status: 403 }) : chatOk('model2'))

  const res = await chatCompletionWithFallback(mustTarget(), REQ)
  assert.equal(res.text, 'model2')
  assert.equal(res.used.providerId, 'deepseek')
  assert.equal(res.used.model, 'deepseek-reasoner')
  assert.equal(res.switchedFrom?.providerId, 'deepseek')
  assert.equal(res.switchedFrom?.model, 'deepseek-chat')
  assert.ok(res.switchedFrom?.reason.includes('HTTP 403'))
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map((c) => c.model), ['deepseek-chat', 'deepseek-reasoner'])
  assert.ok(calls.every((c) => c.url.startsWith('https://api.deepseek.com/v1/chat/completions')))
})

test('模型回退开关关闭：列表再长也不用，保持原错误（同目标退避重试后透出）', async () => {
  putProviderBundle([{ ...DS_MODEL_FB, enableModelFallback: false }, KIMI], { enableProviderFallback: false })
  calls = []
  respond = () => new Response('down', { status: 500 })

  await assert.rejects(chatCompletionWithFallback(mustTarget(), REQ), /HTTP 500/)
  assert.equal(calls.length, 3)
})

test('同卡模型全部失败（Provider 回退关）：错误带模型粒度的整条链', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: false })
  calls = []
  respond = () => new Response('down', { status: 500 })

  await assert.rejects(
    chatCompletionWithFallback(mustTarget(), REQ),
    (e: unknown) => e instanceof Error
      && e.message.includes('模型回退均失败')
      && e.message.includes('deepseek-chat')
      && e.message.includes('deepseek-reasoner'),
  )
  assert.equal(calls.length, 6) // 2 个模型 × 同目标 3 次
})

test('两级回退联动全败：同卡模型用尽后切下一个服务商的模型链，错误带整条链', async () => {
  putProviderBundle(
    [DS_MODEL_FB, { ...KIMI, enableModelFallback: true, modelFallbacks: ['kimi-k2', 'kimi-k1.5'] }],
    { enableProviderFallback: true },
  )
  calls = []
  respond = () => new Response('down', { status: 500 })

  await assert.rejects(
    chatCompletionWithFallback(mustTarget(), REQ),
    (e: unknown) => e instanceof Error
      && e.message.includes('所有可用服务商均失败')
      && e.message.includes('deepseek-reasoner')
      && e.message.includes('kimi-k1.5'),
  )
  assert.equal(calls.length, 12) // 2 张卡 × 各 2 个模型 × 同目标 3 次
})

test('两级回退联动成功：主卡模型尽败后下一服务商应答，switchedFrom 记原目标', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: true })
  calls = []
  respond = (model) => (model.startsWith('deepseek') ? new Response('down', { status: 500 }) : chatOk('kimi'))

  const res = await chatCompletionWithFallback(mustTarget(), REQ)
  assert.equal(res.text, 'kimi')
  assert.equal(res.used.providerId, 'kimi')
  assert.equal(res.used.model, 'kimi-k2')
  assert.equal(res.switchedFrom?.providerId, 'deepseek')
  assert.equal(res.switchedFrom?.model, 'deepseek-chat')
  assert.equal(calls.length, 7) // deepseek 2 模型 × 同目标 3 次 + kimi 1 次
})

test('请求中止：即使卡开了模型回退也不再试下一个模型', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: true })
  calls = []
  const controller = new AbortController()
  respond = () => {
    controller.abort()
    return new Response('down', { status: 500 })
  }

  await assert.rejects(
    chatCompletionWithFallback(mustTarget(), { ...REQ, signal: controller.signal }),
    /HTTP 500/,
  )
  assert.equal(calls.length, 1) // 首个模型失败时请求已中止：不打备用模型，也不切服务商
})

// ── 内容级失败与错误分类（照搬成熟方案的扩展契约） ─────────────────────────

test('内容校验失败进回退链：主模型解析失败后换下一个模型成功', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: false })
  calls = []
  respond = (model) => (model === 'deepseek-chat' ? chatOk('not json at all') : chatOk('{"match":"x"}'))

  const res = await chatCompletionWithFallback(mustTarget(), REQ, {
    validate: (text) => {
      if (!text.includes('{')) throw new Error('回落模型没有返回可解析的 JSON 读数')
    },
  })
  assert.equal(res.used.model, 'deepseek-reasoner')
  assert.ok(res.switchedFrom?.reason.includes('回落模型没有返回可解析的 JSON 读数'))
  assert.equal(calls.length, 2) // 内容级失败不做同目标重试：直接换下一个模型
})

test('内容校验全链失败：错误带每个模型的校验现场', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: false })
  calls = []
  respond = () => chatOk('not json at all')

  await assert.rejects(
    chatCompletionWithFallback(mustTarget(), REQ, {
      validate: () => {
        throw new Error('回落模型没有返回可解析的 JSON 读数')
      },
    }),
    (e: unknown) =>
      e instanceof Error &&
      e.message.includes('模型回退均失败') &&
      e.message.includes('deepseek-chat') &&
      e.message.includes('deepseek-reasoner') &&
      e.message.includes('回落模型没有返回可解析的 JSON 读数'),
  )
})

test('内容校验单目标单模型：校验错误逐字透出（与未接回退时同文案）', async () => {
  putProviderBundle([DEEPSEEK, KIMI], { enableProviderFallback: false })
  calls = []
  respond = () => chatOk('not json at all')

  await assert.rejects(
    chatCompletionWithFallback(mustTarget(), REQ, {
      validate: () => {
        throw new Error('回落模型没有返回可解析的 JSON 读数')
      },
    }),
    /回落模型没有返回可解析的 JSON 读数/,
  )
  assert.equal(calls.length, 1)
})

test('401 鉴权失败：即使配了模型回退与 Provider 回退也整链停止，原错误透出', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: true })
  calls = []
  respond = () => new Response('bad key', { status: 401 })

  await assert.rejects(chatCompletionWithFallback(mustTarget(), REQ), /HTTP 401/)
  assert.equal(calls.length, 1) // 不做同目标重试、不换模型、不切服务商
})

test('5xx 同目标退避重试：首次失败、重试成功则不再换模型', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: false })
  calls = []
  let first = true
  respond = () => {
    if (first) {
      first = false
      return new Response('down', { status: 500 })
    }
    return chatOk('recovered')
  }

  const res = await chatCompletionWithFallback(mustTarget(), REQ)
  assert.equal(res.text, 'recovered')
  assert.equal(res.used.model, 'deepseek-chat')
  assert.equal(res.switchedFrom, undefined)
  assert.equal(calls.length, 2)
})

test('封顶：模型级尝试最多 8 次（防长回退列表把一次判定拖成马拉松）', async () => {
  putProviderBundle(
    [
      {
        ...DEEPSEEK,
        enableModelFallback: true,
        modelFallbacks: ['deepseek-chat', ...Array.from({ length: 15 }, (_, i) => `m${i}`)],
      },
      KIMI,
    ],
    { enableProviderFallback: false },
  )
  calls = []
  respond = () => new Response('down', { status: 500 })

  await assert.rejects(
    chatCompletionWithFallback(mustTarget(), REQ),
    (e: unknown) => e instanceof Error && e.message.includes('8 次上限'),
  )
  assert.equal(calls.length, 24) // 8 个模型 × 同目标 3 次，第 9 个模型前封顶
})

test('超时按可重试类处理：同目标重试后换下一个模型应答', async () => {
  putProviderBundle([DS_MODEL_FB, KIMI], { enableProviderFallback: false })
  calls = []
  respond = (model, init) =>
    model === 'deepseek-chat'
      ? new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new DOMException('This operation was aborted', 'AbortError'))
          })
        })
      : chatOk('after-timeout')

  const res = await chatCompletionWithFallback(mustTarget(), REQ, { timeoutMs: 15, backoffMs: [0, 0] })
  assert.equal(res.used.model, 'deepseek-reasoner')
  assert.equal(calls.length, 4) // 超时同目标 1 + 重试 2 = 3 次，再换模型 1 次
})
