// 判定卡回退链离线单测（P0）：不打任何真实网络。
// 覆盖：法律断言判定首卡 429 → 退避重试后按排列顺序切到第二张判定卡；
// 「启用 Provider 回退」关掉 = 只试首卡（限流错误原样透出）；非限流错误不浪费退避重试、直接换卡；
// 整条链失败 = 错误带整条链；限流卡进退避窗口后，窗口内后续判定直接用第二张卡；
// 失败标签 / RAG 两条场景管线同样回退；
// 一键全测侧：判定返回 error 徽标 → 该条记失败并按 429 退避重试，不可重试错误直接抛。
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JEV_PROVIDER_ID, JEV_PROVIDER_ID_OPENCODE } from '../shared/jev'
import {
  ASSERTION_QUESTION_IDS,
  getAssertionTask,
  runAssertionJudge,
} from '../server/playground/assertionJudge'
import { TAG_QUESTION_IDS, getTagTask, runTagJudge } from '../server/playground/tagJudge'
import { RAG_QUESTION_IDS, getRagTask, runRagJudge } from '../server/playground/ragJudge'
import { clearDecisionBackoff } from '../server/playground/decisionChain'
import { putJevSettings } from '../server/playground/jevSettings'
import { putProviderBundle } from '../server/settingsStore'
import { assertionScenario, playgroundScenario } from '../src/screens/Playground/batchRunner'

process.env['HWT_SETTINGS_FILE'] = join(mkdtempSync(join(tmpdir(), 'hwt-dfb-')), 'settings.json')
// 退避不空等（重试次数照旧，便于断言调用次数）；窗口默认不开，专门那条用例临时打开。
process.env['HWT_JEV_BACKOFF_MS'] = '0'
process.env['HWT_JEV_429_COOLDOWN_MS'] = '0'

// ── 假 HTTP 层：真实 fetch 被替换，测试结束后还原 ──────────────────────────

const realFetch = globalThis.fetch
let calls: string[] = []
let respond: (url: string) => Response = () => json({})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url)
  calls.push(url)
  return respond(url)
}) as typeof globalThis.fetch

after(() => {
  globalThis.fetch = realFetch
})

/** 法律断言三问齐答（Choice + Score + Noul），置信度取 Choice/Score 较小值。 */
function assertionAnswers(choice: string, conf: number, score: number, scoreConf: number, model?: string): Response {
  return json({
    ...(model != null ? { model } : {}),
    answers: {
      [ASSERTION_QUESTION_IDS.cls]: { choice, probabilities: { [choice]: conf }, confidence: conf },
      [ASSERTION_QUESTION_IDS.support]: { score, probabilities: { [`${score}`]: scoreConf }, confidence: scoreConf },
      [ASSERTION_QUESTION_IDS.reachable]: { noul: 0.9 },
    },
  })
}

/** 单 Choice 场景（失败标签 / RAG）的应答体。 */
function choiceAnswers(id: string, choice: string, conf: number, model?: string): Response {
  return json({
    ...(model != null ? { model } : {}),
    answers: { [id]: { choice, probabilities: { [choice]: conf }, confidence: conf } },
  })
}

/** 两张判定卡都配置可用：TypeSafe 在前、OpenCode 在后（即界面排列顺序）。 */
function configureBothCards(extra: { enableDecisionProviderFallback?: boolean } = {}): void {
  putProviderBundle(
    [
      { providerId: JEV_PROVIDER_ID, apiKey: 'ts-key', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-1.13.0'], defaultModelId: 'jev-1.13.0', enabled: true },
      { providerId: JEV_PROVIDER_ID_OPENCODE, apiKey: 'oc-key', baseUrl: 'https://opencode.ai/zen/v1', modelIds: ['jev-1.13'], defaultModelId: 'jev-1.13', enabled: true },
    ],
    extra,
  )
}

const assertionTask = getAssertionTask('A1')!
const SECOND_CARD_OK = (): Response => assertionAnswers('supported', 0.95, 4, 0.93, 'jev-1.13')

test('法律断言判定：首卡限流 429 → 退避重试后按排列顺序切到第二张判定卡', async () => {
  putJevSettings({ enabled: true })
  configureBothCards()
  calls = []
  respond = (url) => (url.includes('api.typesafe.ai') ? new Response('rate limited', { status: 429 }) : SECOND_CARD_OK())
  const rec = await runAssertionJudge(assertionTask, 'good', assertionTask.goodAnswer)
  assert.equal(rec.result.source, 'decided')
  // 读数由第二张卡给出：应答模型与调用顺序都证明回退发生过。
  assert.equal(rec.result.model, 'jev-1.13')
  assert.equal(calls.length, 4, `unexpected calls: ${calls.join(', ')}`)
  assert.ok(calls.slice(0, 3).every((u) => u.includes('api.typesafe.ai')), calls.join(', '))
  assert.ok(calls[3]!.includes('opencode.ai'), calls[3])
})

test('法律断言判定：首卡 500 不做退避重试，直接切下一张卡', async () => {
  configureBothCards()
  calls = []
  respond = (url) => (url.includes('api.typesafe.ai') ? json({ error: 'boom' }, 500) : SECOND_CARD_OK())
  const rec = await runAssertionJudge(assertionTask, 'good', assertionTask.goodAnswer)
  assert.equal(rec.result.source, 'decided')
  assert.equal(calls.length, 2, `unexpected calls: ${calls.join(', ')}`)
})

test('回退开关关闭：法律断言判定只试首卡，限流错误原样透出', async () => {
  configureBothCards({ enableDecisionProviderFallback: false })
  calls = []
  respond = (url) => (url.includes('api.typesafe.ai') ? new Response('rate limited', { status: 429 }) : SECOND_CARD_OK())
  const rec = await runAssertionJudge(assertionTask, 'good', assertionTask.goodAnswer)
  assert.equal(rec.result.source, 'error')
  assert.ok(rec.result.error!.includes('429'), rec.result.error ?? '')
  // 退避重试仍在（官方要求），但一次都不换卡。
  assert.equal(calls.length, 3, `unexpected calls: ${calls.join(', ')}`)
  assert.ok(calls.every((u) => u.includes('api.typesafe.ai')), calls.join(', '))
})

test('整条链都失败：错误带上每一张判定卡的现场', async () => {
  configureBothCards()
  calls = []
  respond = () => json({ error: 'down' }, 503)
  const rec = await runAssertionJudge(assertionTask, 'good', assertionTask.goodAnswer)
  assert.equal(rec.result.source, 'error')
  assert.ok(rec.result.error!.includes('所有判定卡均失败'), rec.result.error ?? '')
  assert.ok(rec.result.error!.includes(`${JEV_PROVIDER_ID}/`), rec.result.error ?? '')
  assert.ok(rec.result.error!.includes(`${JEV_PROVIDER_ID_OPENCODE}/`), rec.result.error ?? '')
  assert.equal(calls.length, 2, `unexpected calls: ${calls.join(', ')}`)
})

test('限流卡进入退避窗口：窗口内后续判定直接改用第二张卡', async () => {
  process.env['HWT_JEV_429_COOLDOWN_MS'] = '60000'
  clearDecisionBackoff()
  try {
    configureBothCards()
    calls = []
    respond = (url) => (url.includes('api.typesafe.ai') ? new Response('rate limited', { status: 429 }) : SECOND_CARD_OK())
    const first = await runAssertionJudge(assertionTask, 'good', assertionTask.goodAnswer)
    assert.equal(first.result.source, 'decided')
    assert.equal(calls.length, 4, `unexpected calls: ${calls.join(', ')}`)

    // 窗口内再判一条：首卡直接跳过，只打第二张（不再连撞限流）。
    calls = []
    const second = await runAssertionJudge(assertionTask, 'bad', assertionTask.badAnswer)
    assert.equal(second.result.source, 'decided')
    assert.equal(calls.length, 1, `unexpected calls: ${calls.join(', ')}`)
    assert.ok(calls[0]!.includes('opencode.ai'), calls[0])
  } finally {
    process.env['HWT_JEV_429_COOLDOWN_MS'] = '0'
    clearDecisionBackoff()
  }
})

test('失败标签与 RAG 两条场景管线同样按排列顺序回退', async () => {
  putJevSettings({ enabled: true })
  configureBothCards()

  calls = []
  respond = (url) => (url.includes('api.typesafe.ai') ? json({ error: 'boom' }, 500) : choiceAnswers(TAG_QUESTION_IDS.cls, 'scope-violation', 0.95, 'jev-1.13'))
  const tagTask = getTagTask('T1')!
  const tagRec = await runTagJudge(tagTask, 'good')
  assert.equal(tagRec.result.source, 'decided')
  assert.equal(tagRec.result.model, 'jev-1.13')
  assert.equal(calls.length, 2, `unexpected calls: ${calls.join(', ')}`)
  assert.ok(calls[1]!.includes('opencode.ai'), calls[1])

  calls = []
  respond = (url) => (url.includes('api.typesafe.ai') ? json({ error: 'boom' }, 500) : choiceAnswers(RAG_QUESTION_IDS.cls, 'grounded', 0.95, 'jev-1.13'))
  const ragTask = getRagTask('G1')!
  const ragRec = await runRagJudge(ragTask, 'good', ragTask.goodAnswer)
  assert.equal(ragRec.result.source, 'decided')
  assert.equal(ragRec.result.model, 'jev-1.13')
  assert.equal(calls.length, 2, `unexpected calls: ${calls.join(', ')}`)
  assert.ok(calls[1]!.includes('opencode.ai'), calls[1])
})

// ── 一键全测侧：error 徽标 → 记失败 + 退避重试 ──────────────────────────────

function judgeErrorRecord(message: string): Response {
  return json({ result: { source: 'error', error: message, choice: null, consistency: 'incomparable' }, detSuccess: null })
}

/** 实况评估场景的判定接口直接回一条 JevJudgeResult（不套 result 外壳），失败同样是 error 徽标。 */
function playgroundJudgeError(message: string): Response {
  return json({ source: 'error', error: message, choice: null, consistency: 'incomparable' })
}

test('一键全测（法律断言）：判定返回 error 徽标 → 先退避重试，成功后该条才算成功', async () => {
  let attempts = 0
  respond = () => {
    attempts += 1
    return attempts === 1
      ? judgeErrorRecord('Jev HTTP 429（官方建议指数退避）: FreeUsageLimitError')
      : json({ result: { source: 'decided', choice: { choice: 'supported' }, consistency: 'consistent' }, detSuccess: null })
  }
  const out = await assertionScenario([]).judge('A1', 'answer', 'good', 'batch-x', false)
  assert.equal(out.choice, 'supported')
  assert.equal(out.consistency, 'consistent')
  assert.equal(attempts, 2, `unexpected attempts: ${attempts}`)
})

test('一键全测（法律断言）：不可重试的错误直接抛出（该条记失败，不空等重试）', async () => {
  let attempts = 0
  respond = () => {
    attempts += 1
    return judgeErrorRecord('Jev HTTP 401: invalid api key')
  }
  await assert.rejects(
    () => assertionScenario([]).judge('A1', 'answer', 'good', 'batch-x', false),
    /401/,
  )
  assert.equal(attempts, 1, `unexpected attempts: ${attempts}`)
})

test('一键全测（实况评估）：判定返回 error 徽标同样记失败并退避重试', async () => {
  let attempts = 0
  respond = (url) => {
    if (url.includes('/api/playground/score')) {
      return json({ taskId: 'G1', scorerType: 'gate', success: true, score: 1, factChecks: [], articleChecks: [], securityChecks: [], failureTags: [], summary: '' })
    }
    attempts += 1
    return attempts === 1
      ? playgroundJudgeError('fetch failed')
      : json({ source: 'decided', choice: { choice: 'exact' }, consistency: 'incomparable', error: null, success: true })
  }
  const out = await playgroundScenario([]).judge('G1', 'answer', 'good', 'batch-x', false)
  assert.equal(out.choice, 'exact')
  assert.equal(out.success, true)
  assert.equal(attempts, 2, `unexpected attempts: ${attempts}`)
})
