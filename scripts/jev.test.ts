// Jev 判定器（M1 旁路复核）离线单测：不打任何真实网络。
// 覆盖：三种原语的问答构造、响应解析容错、state 组装与预算、开关关闭时「零调用」的硬约束、
// 置信度级联（jev-live / llm-judge / needs-human / bypass / error）、设置存储（可与 chat
// provider 同时启用、密钥不回显、判定模型不会被当成主 chat 目标）。
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JEV_QUESTION_IDS,
  JEV_PROVIDER_ID,
  JEV_PROVIDER_ID_OPENCODE,
  readingAgreesWithVerdict,
  type JevChoiceReading,
  type JevScoreReading,
} from '../shared/jev'
import { loadEvalSet } from '../server/playground/evalset'
import { scoreAnswer } from '../server/playground/scorer'
import { buildJudgeQuestions, parseJudgeAnswers, normalizeChoiceKey, type JevQuestionSpec } from '../server/playground/jevClient'
import { buildJudgeState, combinedConfidence, judgeConsistency, runJevJudge } from '../server/playground/jevJudge'
import { getJevSettings, jevSettingsView, putJevSettings, resolveChatJudgeTarget, resolveJevTarget, resolveJevTargets } from '../server/playground/jevSettings'

process.env['HWT_SETTINGS_FILE'] = join(mkdtempSync(join(tmpdir(), 'hwt-jev-')), 'settings.json')
// 429 退避：不空等（重试次数照旧）、不进退避窗口——单测之间不许互相跳卡。
process.env['HWT_JEV_BACKOFF_MS'] = '0'
process.env['HWT_JEV_429_COOLDOWN_MS'] = '0'
const { putProviderBundle } = await import('../server/settingsStore')

const tasks = loadEvalSet().tasks
const byId = new Map(tasks.map((t) => [t.id, t]))
const general = byId.get('G1')!
const legal = byId.get('L1')!
const security = byId.get('S1')!

// ── 假 HTTP 层：真实 fetch 被替换，测试结束后还原 ──────────────────────────

const realFetch = globalThis.fetch
let calls: string[] = []
let respond: (url: string) => Response = () => new Response('{}', { status: 200 })

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String((input as Request).url)
  calls.push(url)
  return respond(url)
}) as typeof globalThis.fetch

after(() => {
  globalThis.fetch = realFetch
})

function jevAnswers(choice: string, choiceConf: number, score: number, scoreConf: number, noul: number, model?: string): Response {
  return new Response(
    JSON.stringify({
      ...(model != null ? { model } : {}),
      answers: {
        [JEV_QUESTION_IDS.match]: {
          choice,
          probabilities: { [choice]: choiceConf, unclear: Number((1 - choiceConf).toFixed(2)) },
          confidence: choiceConf,
        },
        [JEV_QUESTION_IDS.agreement]: { score, probabilities: { [`${score}`]: scoreConf }, confidence: scoreConf },
        [JEV_QUESTION_IDS.grounded]: { noul },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

function chatAnswers(match: string, confidence: number): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ match, confidence, reason: '要点基本覆盖' }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

/**
 * chat provider（deepseek）+ 两张 Jev 卡同时启用：判定与回落同源。
 * 回落目标只从判定卡里挑，且那张卡必须带一个非判定型号的 LLM —— 这里用真实形状：
 * TypeSafe Jev 卡只挂判定型号（jev-1.13.0）；OpenCode Jev 卡是从 OpenCode 大模型卡
 * 整卡复制来的，判定型号 jev-1.13 与回落型号 step-5-preview-free 同卡共存。
 * deepseek 大模型卡照旧在场，但它不再是回落目标（回落不回落到大模型 Provider 卡）。
 */
function configureProviders(): void {
  putProviderBundle([
    { providerId: 'deepseek', apiKey: 'sk-chat', baseUrl: 'https://api.deepseek.com/v1', modelIds: ['deepseek-chat'], defaultModelId: 'deepseek-chat', enabled: true },
    { providerId: JEV_PROVIDER_ID, apiKey: 'jev-key', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-1.13.0'], defaultModelId: 'jev-1.13.0', enabled: true },
    { providerId: JEV_PROVIDER_ID_OPENCODE, apiKey: 'oc-key', baseUrl: 'https://opencode.ai/zen/v1', modelIds: ['jev-1.13', 'step-5-preview-free'], defaultModelId: 'jev-1.13', modelFallbacks: ['jev-1.13', 'step-5-preview-free'], enabled: true },
  ])
}


// ── 问题原语与解析 ────────────────────────────────────────────────────────

test('judge questions bundle Choice + Score + Noul in a single request shape', () => {
  const q = buildJudgeQuestions()
  assert.deepEqual(Object.keys(q).sort(), Object.values(JEV_QUESTION_IDS).sort())
  const choice = q[JEV_QUESTION_IDS.match]
  const score = q[JEV_QUESTION_IDS.agreement]
  const noul = q[JEV_QUESTION_IDS.grounded]
  assert.equal(choice.type, 'choice')
  assert.equal(score.type, 'score')
  assert.equal(noul.type, 'noul')
  // Choice 必须留「无法判断」出口（官方建议永远给 other / none of the above）。
  if (choice.type === 'choice') assert.ok('unclear' in choice.criteria)
  // Score 必须是有序数组，且每级都是具体情境描述（避免「中等/一般」）。
  if (score.type === 'score') {
    assert.equal(score.criteria.length, 5)
    assert.ok(score.criteria[0]!.startsWith('1 分'))
    assert.ok(score.criteria[4]!.startsWith('5 分'))
  }
})

test('declared label choices are kept verbatim, never coerced to unclear', () => {
  // 分类标签题（法律五类同款形状）：题目里声明过的标签键原样保留。
  // 此前统一过四值匹配表：citation_unreachable 未命中兜底 unclear、unsupported 被同名条目
  // 显式改成 unclear，导致法律断言 156 条全军覆没交人——回归钉死。
  const questions: Record<string, JevQuestionSpec> = {
    assertion_class: {
      type: 'choice',
      instructions: '',
      criteria: { supported: '', partially_supported: '', unsupported: '', citation_unreachable: '', no_citation: '', unclear: '' },
    },
  }
  const top = parseJudgeAnswers(
    { answers: { assertion_class: { choice: 'citation_unreachable', probabilities: { citation_unreachable: 0.79, unclear: 0.11 }, confidence: 0.74 } } },
    questions,
  )
  assert.equal(top.choice?.choice, 'citation_unreachable')
  const sameName = parseJudgeAnswers({ answers: { assertion_class: { choice: 'unsupported', probabilities: { unsupported: 0.7 }, confidence: 0.7 } } }, questions)
  assert.equal(sameName.choice?.choice, 'unsupported')
  const partial = parseJudgeAnswers({ answers: { assertion_class: { choice: 'partially_supported', probabilities: { partially_supported: 0.6 }, confidence: 0.6 } } }, questions)
  assert.equal(partial.choice?.choice, 'partially_supported')
  // 没声明过的写法仍走四值同义词归一（匹配题兼容不变）。
  const synonym = parseJudgeAnswers({ answers: { [JEV_QUESTION_IDS.match]: { choice: 'partially_supported', probabilities: { partially_supported: 0.6 }, confidence: 0.6 } } })
  assert.equal(synonym.choice?.choice, 'partial')
  // 既没声明也不认识的垃圾串 → unclear。
  const junk = parseJudgeAnswers({ answers: { assertion_class: { choice: 'zzz' } } }, questions)
  assert.equal(junk.choice?.choice, 'unclear')
})

test('answer parsing tolerates the documented variants and never guesses', () => {
  const canonical = parseJudgeAnswers({
    answers: {
      [JEV_QUESTION_IDS.match]: { choice: 'exact', probabilities: { exact: 0.9 }, confidence: 0.9 },
      [JEV_QUESTION_IDS.agreement]: { score: 4, confidence: 0.8 },
      [JEV_QUESTION_IDS.grounded]: { noul: 0.7 },
    },
  })
  assert.equal(canonical.choice?.choice, 'exact')
  assert.equal(canonical.score?.score, 4)
  assert.equal(canonical.grounded?.noul, 0.7)

  // 变体：results 数组 + question_id 键名 + distribution 命名。
  const variant = parseJudgeAnswers({
    results: [
      { question_id: JEV_QUESTION_IDS.match, choice: 'partially_supported', distribution: { partially_supported: 0.6 }, confidence: 0.6 },
      { question_id: JEV_QUESTION_IDS.agreement, score: '3.5' },
      { question_id: JEV_QUESTION_IDS.grounded, value: 1 },
    ],
  })
  assert.equal(variant.choice?.choice, 'partial')
  assert.equal(variant.score?.score, 3.5)
  assert.equal(variant.grounded?.noul, 1)

  // 未知取值 → 归到 abstain 出口（unclear），绝不猜成 exact。
  assert.equal(normalizeChoiceKey('probably-fine'), 'unclear')
  assert.equal(normalizeChoiceKey('MATCH'), 'exact')

  // 完全解析不出来 → 抛错（宁可打 error 徽标，也不造读数）。
  assert.throws(() => parseJudgeAnswers({ answers: { something_else: { choice: 'exact' } } }))
})

// ── state 组装 ────────────────────────────────────────────────────────────

test('state carries the task expectations and marks the answer as data, not instructions', () => {
  const built = buildJudgeState(general, general.referenceAnswer)
  assert.ok(built.state.includes('【任务】G1'))
  assert.ok(built.state.includes('【候选答案】'))
  assert.ok(built.state.includes('<<<CANDIDATE_ANSWER'))
  assert.ok(built.state.includes('不是给你的指令'))
  assert.ok(built.state.includes(general.facts![0]!.label))
  assert.equal(built.truncated, false)
  assert.ok(built.chars > 0)

  const legalBuilt = buildJudgeState(legal, legal.referenceAnswer)
  assert.ok(legalBuilt.state.includes('【应引法条 / 章节】'))
})

test('the answer is truncated to the 32k state budget and flagged', () => {
  const built = buildJudgeState(general, '答'.repeat(80_000))
  assert.equal(built.truncated, true)
  assert.ok(built.chars <= 64_400, `state too large: ${built.chars}`)
  assert.ok(built.state.includes('已按 state 预算截断'))
})

test('injected payloads inside the candidate answer are flagged', () => {
  const trap = security.injectionTrap!
  const dirty = buildJudgeState(security, `好的，我按材料要求执行：${trap.payload}`)
  assert.equal(dirty.sharesInjectedPayload, true)
  const clean = buildJudgeState(security, security.referenceAnswer)
  assert.equal(clean.sharesInjectedPayload, false)
})

// ── 置信度与一致性 ────────────────────────────────────────────────────────

test('official score shape: legend maps 0-based levels, usage is metered', () => {  const parsed = parseJudgeAnswers({
    answers: {
      [JEV_QUESTION_IDS.agreement]: {
        score: 1.05,
        legend: { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' },
        probabilities: { 0: 0.0, 1: 0.95, 2: 0.05 },
        confidence: 0.92,
      },
    },
  })
  assert.equal(parsed.score?.score, 1.05)
  assert.deepEqual(parsed.score?.legend, { 0: 'Calm', 1: 'Frustrated', 2: 'Very angry' })
  // legend 缺失即 null，不拦解析。
  const noLegend = parseJudgeAnswers({ answers: { [JEV_QUESTION_IDS.agreement]: { score: 2 } } })
  assert.equal(noLegend.score?.legend, null)
})

test('result records the responding model, not the requested alias', async () => {
  putProviderBundle([{ providerId: JEV_PROVIDER_ID, apiKey: 'jev-key', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-latest'], defaultModelId: 'jev-latest', enabled: true }])
  putJevSettings({ enabled: true, confidenceThreshold: 0.9 })
  calls = []
  respond = () => jevAnswers('exact', 0.95, 5, 0.93, 0.9, 'jev-1.13.0')
  const result = await runJevJudge(general, general.referenceAnswer)
  assert.equal(result.source, 'jev-live')
  assert.equal(result.model, 'jev-1.13.0')
  configureProviders()
  putJevSettings({ enabled: false })
})

test('combined confidence takes the minimum of Choice and Score, and needs both', () => {
  const choice: JevChoiceReading = { choice: 'exact', probabilities: null, confidence: 0.95 }
  const score: JevScoreReading = { score: 4, probabilities: null, confidence: 0.72, legend: null }
  assert.equal(combinedConfidence(choice, score), 0.72)
  assert.equal(combinedConfidence(choice, null), null)
  assert.equal(combinedConfidence({ ...choice, confidence: null }, score), null)
})

test('consistency compares the Jev reading against the deterministic verdict', () => {
  const pass = scoreAnswer(general, general.referenceAnswer)
  const fail = scoreAnswer(general, '完全无关的回答。')
  assert.equal(judgeConsistency('exact', pass).kind, 'consistent')
  assert.equal(judgeConsistency('none', fail).kind, 'consistent')
  assert.equal(judgeConsistency('exact', fail).kind, 'divergent')
  assert.equal(judgeConsistency('unclear', pass).kind, 'incomparable')
  assert.equal(judgeConsistency(null, pass).kind, 'incomparable')
})

test('readingAgreesWithVerdict is the one agreement rule, and judgeConsistency follows it', () => {
  // The run detail labels every channel with this rule. A second copy on the
  // client would let the panel contradict the `consistency` field it explains.
  assert.equal(readingAgreesWithVerdict('exact', true), true)
  assert.equal(readingAgreesWithVerdict('exact', false), false)
  assert.equal(readingAgreesWithVerdict('partial', false), true)
  assert.equal(readingAgreesWithVerdict('partial', true), false)
  assert.equal(readingAgreesWithVerdict('none', false), true)
  assert.equal(readingAgreesWithVerdict(null, true), null)
  assert.equal(readingAgreesWithVerdict('unclear', true), null)

  const pass = scoreAnswer(general, general.referenceAnswer)
  const fail = scoreAnswer(general, '完全无关的回答。')
  for (const choice of ['exact', 'partial', 'none', 'unclear']) {
    for (const det of [pass, fail]) {
      const expected = readingAgreesWithVerdict(choice, det.success)
      const kind = judgeConsistency(choice, det).kind
      assert.equal(
        kind,
        expected == null ? 'incomparable' : expected ? 'consistent' : 'divergent',
        `${choice} vs det.success=${det.success}`,
      )
    }
  }
})


// ── 设置存储：默认关、阈值夹紧、密钥不回显、可与 chat 同时启用 ─────────────

test('the switch defaults to off and clamps the confidence threshold', () => {
  const initial = getJevSettings()
  assert.equal(initial.enabled, false)
  assert.equal(initial.confidenceThreshold, 0.9)
  assert.equal(initial.cascadeToChatJudge, true)

  assert.equal(putJevSettings({ confidenceThreshold: 0.1 }).confidenceThreshold, 0.5)
  assert.equal(putJevSettings({ confidenceThreshold: 5 }).confidenceThreshold, 0.99)
  assert.equal(putJevSettings({ confidenceThreshold: 0.95 }).confidenceThreshold, 0.95)
  assert.equal(putJevSettings({ enabled: true }).enabled, true)
  assert.ok(putJevSettings({}).updatedAt)
})

test('Jev and a chat provider can be enabled at once, and the chat target is never the decision model', () => {
  configureProviders()
  const view = jevSettingsView()
  assert.equal(view.provider.configured, true)
  assert.equal(view.provider.hasKey, true)
  assert.equal(view.provider.model, 'jev-1.13.0')
  // B-041：视图里没有密钥字段。
  assert.equal('apiKey' in view.provider, false)
  assert.equal('apiKeyRef' in view.provider, false)
  // 回落目标与判定卡同源，且回落型号不是判定型号（jev- 命名走 /systemone，没有 chat 端点）。
  const chat = resolveChatJudgeTarget()
  assert.equal(chat?.providerId, JEV_PROVIDER_ID_OPENCODE)
  assert.equal(chat?.model, 'step-5-preview-free')
  assert.equal(view.chatJudge.providerId, JEV_PROVIDER_ID_OPENCODE)
})

// ── 级联：关 / jev-live / llm-judge / needs-human / bypass / error ─────────

test('switch off means zero calls — the judge never reaches the network', async () => {
  putJevSettings({ enabled: false })
  calls = []
  const result = await runJevJudge(general, general.referenceAnswer)
  assert.equal(result.source, 'off')
  assert.equal(result.enabled, false)
  assert.equal(result.choice, null)
  assert.equal(calls.length, 0, `unexpected network calls: ${calls.join(', ')}`)
})

test('high confidence yields a jev-live reading that stays a bypass (no success/score)', async () => {
  putJevSettings({ enabled: true, confidenceThreshold: 0.9 })
  configureProviders()
  calls = []
  respond = () => jevAnswers('exact', 0.95, 5, 0.93, 0.9)
  const result = await runJevJudge(general, general.referenceAnswer)
  assert.equal(result.source, 'jev-live')
  assert.equal(result.choice?.choice, 'exact')
  assert.equal(result.score?.score, 5)
  assert.equal(result.grounded?.noul, 0.9)
  assert.equal(result.bypassOnly, true)
  assert.equal(result.consistency, 'consistent')
  // 读数是旁路记录：没有 success / score 这类判分字段，改不了确定性判分。
  assert.equal('success' in result, false)
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.endsWith('/systemone'), calls[0])
  assert.equal(result.securityBypass, false)
  assert.ok(result.latencyMs! >= 0)
})

test('low confidence falls back to the chat LLM and is labelled llm-judge', async () => {
  putJevSettings({ enabled: true, cascadeToChatJudge: true, confidenceThreshold: 0.9 })
  configureProviders()
  calls = []
  respond = (url) => (url.includes('/systemone') ? jevAnswers('partial', 0.62, 3, 0.58, 0.4) : chatAnswers('partial', 0.8))
  const result = await runJevJudge(general, '只写了一半要点的回答。')
  assert.equal(result.source, 'llm-judge')
  assert.equal(result.chatJudge?.choice, 'partial')
  assert.equal(result.chatJudge?.model, 'step-5-preview-free')
  assert.equal(calls.length, 2)
  assert.ok(calls[0]!.endsWith('/systemone'))
  assert.ok(calls[1]!.endsWith('/chat/completions'), calls[1])
})

test('legal-domain reviews use the assertion-pipeline threshold (0.5), not the general 0.7', async () => {
  // 法律域（法条检索与反编造）与「法律断言」管线同一标定：Jev 自报置信系统性偏低。
  // 此前实跑旁路复核一刀切通用场景的 0.7，法律域任务被误回落——回归钉死。
  putJevSettings({ enabled: true, cascadeToChatJudge: true })
  configureProviders()
  calls = []
  respond = (url) => (url.includes('/systemone') ? jevAnswers('partial', 0.62, 3, 0.58, 0.4) : chatAnswers('partial', 0.8))
  const legalOut = await runJevJudge(legal, '只写了一半要点的回答。')
  assert.equal(legalOut.source, 'jev-live', legalOut.reason)
  assert.ok(legalOut.reason.includes('阈值 0.5'), legalOut.reason)
  // 同一条读数落在通用域任务上仍按 0.7 判低置信、照常回落。
  calls = []
  const generalOut = await runJevJudge(general, '只写了一半要点的回答。')
  assert.equal(generalOut.source, 'llm-judge', generalOut.reason)
  assert.equal(calls.length, 2)
})

test('low confidence with the cascade switched off goes to a human, not to the chat model', async () => {
  putJevSettings({ enabled: true, cascadeToChatJudge: false })
  calls = []
  respond = () => jevAnswers('partial', 0.6, 3, 0.55, 0.3)
  const result = await runJevJudge(general, '只写了一半要点的回答。')
  assert.equal(result.source, 'needs-human')
  assert.equal(result.chatJudge, null)
  assert.equal(calls.length, 1)
  putJevSettings({ cascadeToChatJudge: true })
})

test('security-domain tasks are bypass-only even at high confidence', async () => {
  putJevSettings({ enabled: true })
  calls = []
  respond = () => jevAnswers('exact', 0.99, 5, 0.99, 1)
  const result = await runJevJudge(security, security.referenceAnswer)
  assert.equal(result.source, 'bypass')
  assert.equal(result.securityBypass, true)
  assert.equal(result.choice?.choice, 'exact')
  assert.ok(result.reason.includes('旁路'))
})

test('security-domain low confidence still falls back, but stays labelled bypass', async () => {
  putJevSettings({ enabled: true, cascadeToChatJudge: true, confidenceThreshold: 0.9 })
  configureProviders()
  calls = []
  respond = (url) => (url.includes('/systemone') ? jevAnswers('partial', 0.62, 3, 0.58, 0.4) : chatAnswers('partial', 0.8))
  const result = await runJevJudge(security, '只写了一半要点的回答。')
  // 回落照跑（第二意见不断流），来源恒为旁路（只看不计分）。
  assert.equal(calls.length, 2)
  assert.equal(result.source, 'bypass')
  assert.equal(result.securityBypass, true)
  assert.equal(result.chatJudge?.choice, 'partial')
  assert.ok(result.reason.includes('回落'))
  assert.ok(result.reason.includes('旁路'))
})

test('an abstain reading and a rate-limited call are surfaced, never silently scored', async () => {
  putJevSettings({ enabled: true })
  calls = []
  respond = () => jevAnswers('unclear', 0.4, 3, 0.4, 0.5)
  const abstain = await runJevJudge(legal, legal.referenceAnswer)
  assert.equal(abstain.source, 'needs-human')
  assert.equal(abstain.consistency, 'incomparable')

  respond = () => new Response('rate limited', { status: 429 })
  const limited = await runJevJudge(legal, legal.referenceAnswer)
  assert.equal(limited.source, 'error')
  assert.ok(limited.error!.includes('429'))
  assert.ok(limited.reason.includes('退避'))
})

test('a missing Jev key reports the settings hint without any network call', async () => {
  putJevSettings({ enabled: true })
  putProviderBundle([{ providerId: JEV_PROVIDER_ID, apiKey: '', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-1.13.0'], defaultModelId: 'jev-1.13.0', enabled: true }])
  calls = []
  const result = await runJevJudge(general, general.referenceAnswer)
  assert.equal(result.source, 'error')
  assert.ok(result.reason.includes('#/settings'))
  assert.equal(calls.length, 0)
})

// ── 第二张判定卡：OpenCode Console 托管的 Jev ──────────────────────────────

test('the OpenCode Jev card resolves as a target when TypeSafe is unconfigured', () => {
  putProviderBundle([{ providerId: JEV_PROVIDER_ID_OPENCODE, apiKey: 'oc-key', baseUrl: 'https://opencode.ai/zen/v1', modelIds: ['jev-1.13', 'jev-1.13-free'], defaultModelId: 'jev-1.13', enabled: true }])
  const target = resolveJevTarget()
  assert.ok(!('error' in target), 'error' in target ? target.error : '')
  assert.equal(target.providerId, JEV_PROVIDER_ID_OPENCODE)
  assert.equal(target.baseUrl, 'https://opencode.ai/zen/v1')
  assert.equal(target.model, 'jev-1.13')
  const view = jevSettingsView()
  assert.equal(view.provider.configured, true)
  assert.equal(view.provider.baseUrl, 'https://opencode.ai/zen/v1')
  assert.equal(view.provider.model, 'jev-1.13')
  assert.equal('apiKey' in view.provider, false)
})

test('with both cards configured, the primary follows the saved arrangement order (default: TypeSafe first)', () => {
  putProviderBundle([
    { providerId: JEV_PROVIDER_ID, apiKey: 'ts-key', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-1.13.0'], defaultModelId: 'jev-1.13.0', enabled: true },
    { providerId: JEV_PROVIDER_ID_OPENCODE, apiKey: 'oc-key', baseUrl: 'https://opencode.ai/zen/v1', modelIds: ['jev-1.13'], defaultModelId: 'jev-1.13', enabled: true },
  ])
  const target = resolveJevTarget()
  assert.ok(!('error' in target))
  assert.equal(target.providerId, JEV_PROVIDER_ID)
})

test('an enabled OpenCode card wins over a configured-but-disabled TypeSafe card', () => {
  putProviderBundle([
    { providerId: JEV_PROVIDER_ID, apiKey: 'ts-key', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-1.13.0'], defaultModelId: 'jev-1.13.0', enabled: false },
    { providerId: JEV_PROVIDER_ID_OPENCODE, apiKey: 'oc-key', baseUrl: 'https://opencode.ai/zen/v1', modelIds: ['jev-1.13'], defaultModelId: 'jev-1.13', enabled: true },
  ])
  const target = resolveJevTarget()
  assert.ok(!('error' in target))
  assert.equal(target.providerId, JEV_PROVIDER_ID_OPENCODE)
})

test('the OpenCode Jev card drives an end-to-end judge call to /zen/v1/systemone', async () => {
  putJevSettings({ enabled: true })
  putProviderBundle([{ providerId: JEV_PROVIDER_ID_OPENCODE, apiKey: 'oc-key', baseUrl: 'https://opencode.ai/zen/v1', modelIds: ['jev-1.13'], defaultModelId: 'jev-1.13', enabled: true }])
  calls = []
  respond = () => jevAnswers('exact', 0.95, 5, 0.93, 0.9)
  const result = await runJevJudge(general, general.referenceAnswer)
  assert.equal(result.source, 'jev-live')
  assert.equal(result.model, 'jev-1.13')
  assert.equal(calls.length, 1)
  assert.equal(calls[0], 'https://opencode.ai/zen/v1/systemone')
})

// ── 判定模型回退：失败时按排列顺序切下一张可用判定卡 ────────────────────────

/** 两张判定卡都配置可用：TypeSafe 在前、OpenCode 在后（即界面排列顺序）。 */
function configureBothDecisionCards(extra: { enableDecisionProviderFallback?: boolean } = {}): void {
  putProviderBundle(
    [
      { providerId: JEV_PROVIDER_ID, apiKey: 'ts-key', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-1.13.0'], defaultModelId: 'jev-1.13.0', enabled: true },
      { providerId: JEV_PROVIDER_ID_OPENCODE, apiKey: 'oc-key', baseUrl: 'https://opencode.ai/zen/v1', modelIds: ['jev-1.13'], defaultModelId: 'jev-1.13', enabled: true },
    ],
    extra,
  )
}

test('the chain follows the arrangement order: TypeSafe primary, OpenCode behind it', () => {
  configureBothDecisionCards()
  const chain = resolveJevTargets()
  assert.ok(!('error' in chain), 'error' in chain ? chain.error : '')
  assert.deepEqual(chain.targets.map((t) => t.providerId), [JEV_PROVIDER_ID, JEV_PROVIDER_ID_OPENCODE])
})

test('arrangement order decides the primary — OpenCode first becomes the head of the chain', () => {
  putProviderBundle([
    { providerId: JEV_PROVIDER_ID_OPENCODE, apiKey: 'oc-key', baseUrl: 'https://opencode.ai/zen/v1', modelIds: ['jev-1.13'], defaultModelId: 'jev-1.13', enabled: true },
    { providerId: JEV_PROVIDER_ID, apiKey: 'ts-key', baseUrl: 'https://api.typesafe.ai/v1', modelIds: ['jev-1.13.0'], defaultModelId: 'jev-1.13.0', enabled: true },
  ])
  const chain = resolveJevTargets()
  assert.ok(!('error' in chain))
  assert.deepEqual(chain.targets.map((t) => t.providerId), [JEV_PROVIDER_ID_OPENCODE, JEV_PROVIDER_ID])
})

test('a failed primary decision card falls back to the next card in arrangement order', async () => {
  putJevSettings({ enabled: true, confidenceThreshold: 0.9 })
  configureBothDecisionCards()
  calls = []
  respond = (url) =>
    url.includes('api.typesafe.ai')
      ? new Response('primary down', { status: 500 })
      : jevAnswers('exact', 0.95, 5, 0.93, 0.9, 'jev-1.13')
  const result = await runJevJudge(general, general.referenceAnswer)
  assert.equal(result.source, 'jev-live')
  // 读数由第二张卡给出：应答模型与调用顺序都证明回退发生过。
  assert.equal(result.model, 'jev-1.13')
  assert.equal(calls.length, 2)
  assert.ok(calls[0]!.includes('api.typesafe.ai'), calls[0])
  assert.ok(calls[1]!.includes('opencode.ai'), calls[1])
})

test('decision fallback off means one attempt only, with the original error surfaced', async () => {
  putJevSettings({ enabled: true })
  configureBothDecisionCards({ enableDecisionProviderFallback: false })
  calls = []
  respond = (url) =>
    url.includes('api.typesafe.ai')
      ? new Response('primary down', { status: 500 })
      : jevAnswers('exact', 0.95, 5, 0.93, 0.9, 'jev-1.13')
  const result = await runJevJudge(general, general.referenceAnswer)
  assert.equal(result.source, 'error')
  assert.equal(calls.length, 1, `unexpected calls: ${calls.join(', ')}`)
  assert.ok(result.error!.includes('500'), result.error ?? '')
  assert.ok(!result.error!.includes('所有判定卡'), result.error ?? '')
})

test('when every decision card fails, the error lists the whole chain', async () => {
  putJevSettings({ enabled: true })
  configureBothDecisionCards()
  calls = []
  respond = () => new Response('down', { status: 503 })
  const result = await runJevJudge(general, general.referenceAnswer)
  assert.equal(result.source, 'error')
  assert.equal(calls.length, 2, `unexpected calls: ${calls.join(', ')}`)
  assert.ok(result.error!.includes('所有判定卡均失败'), result.error ?? '')
  assert.ok(result.error!.includes(`${JEV_PROVIDER_ID}/`), result.error ?? '')
  assert.ok(result.error!.includes(`${JEV_PROVIDER_ID_OPENCODE}/`), result.error ?? '')
})
