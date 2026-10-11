import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CUSTOM_PRESET_ID,
  PRESET_PROVIDERS,
  isDecisionProvider,
  trimBaseUrl,
} from '../shared/provider'
import { JEV_DEFAULT_BASE_URL, JEV_MODEL_IDS, JEV_OPENCODE_DEFAULT_BASE_URL, JEV_OPENCODE_MODEL_IDS, JEV_PROVIDER_ID, JEV_PROVIDER_ID_OPENCODE } from '../shared/jev'
import { getModelCapabilities, getModelCatalog } from '../server/providers/model-capabilities-registry'

process.env['HWT_SETTINGS_FILE'] = join(mkdtempSync(join(tmpdir(), 'hwt-settings-')), 'settings.json')
const { deleteSetting, getSetting, getSettings, putProviderBundle, putSetting } = await import('../server/settingsStore')

test('fifteen preset cards (12 vendors + custom + 2 Jev decision models), all well-formed', () => {
  assert.equal(PRESET_PROVIDERS.length, 15)
  const ids = PRESET_PROVIDERS.map((v) => v.id)
  assert.equal(new Set(ids).size, 15)
  assert.equal(CUSTOM_PRESET_ID, 'custom')
  for (const v of PRESET_PROVIDERS) {
    assert.ok(v.name && v.desc && v.keyPlaceholder, v.id)
    if (v.id !== CUSTOM_PRESET_ID) assert.ok(v.defaultBaseUrl.startsWith('https://'), v.id)
  }
})

test('both Jev cards are decision providers, sit last, and carry the System One endpoint', () => {
  const jev = PRESET_PROVIDERS.find((p) => p.id === JEV_PROVIDER_ID)
  assert.ok(jev, 'missing TypeSafe Jev card')
  assert.equal(jev!.kind, 'decision')
  assert.equal(jev!.defaultBaseUrl, JEV_DEFAULT_BASE_URL)
  const oc = PRESET_PROVIDERS.find((p) => p.id === JEV_PROVIDER_ID_OPENCODE)
  assert.ok(oc, 'missing OpenCode Jev card')
  assert.equal(oc!.kind, 'decision')
  assert.equal(oc!.defaultBaseUrl, JEV_OPENCODE_DEFAULT_BASE_URL)
  // 判定模型必须排在最后两张：按数组顺序取「第一个启用的可用 provider」时不会被误当主 chat 目标。
  assert.equal(PRESET_PROVIDERS[PRESET_PROVIDERS.length - 2]!.id, JEV_PROVIDER_ID)
  assert.equal(PRESET_PROVIDERS[PRESET_PROVIDERS.length - 1]!.id, JEV_PROVIDER_ID_OPENCODE)
  // 其余 13 张卡都是 chat（或未标 kind = chat）。
  for (const p of PRESET_PROVIDERS) {
    if (p.id === JEV_PROVIDER_ID || p.id === JEV_PROVIDER_ID_OPENCODE) continue
    assert.notEqual(p.kind, 'decision', p.id)
  }
  assert.equal(isDecisionProvider(JEV_PROVIDER_ID), true)
  assert.equal(isDecisionProvider(JEV_PROVIDER_ID_OPENCODE), true)
  for (const id of ['deepseek', 'gemini', 'custom', 'opencode']) assert.equal(isDecisionProvider(id), false, id)
})

test('the model catalog lists both cards’ hosted Jev model ids', () => {
  const catalog = getModelCatalog() as Record<string, { id: string }[]>
  assert.deepEqual((catalog[JEV_PROVIDER_ID] ?? []).map((m) => m.id), [...JEV_MODEL_IDS])
  assert.deepEqual((catalog[JEV_PROVIDER_ID_OPENCODE] ?? []).map((m) => m.id), [...JEV_OPENCODE_MODEL_IDS])
})

test('baseUrl trimming strips whitespace and trailing slashes', () => {
  assert.equal(trimBaseUrl('https://x.example/v1///  '), 'https://x.example/v1')
  assert.equal(trimBaseUrl('https://x.example/v1'), 'https://x.example/v1')
})

test('settings store round-trips a provider bundle (provider_all + legacy rows)', () => {
  const app = putProviderBundle(
    [{ providerId: 'deepseek', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', modelIds: ['deepseek-chat'], defaultModelId: 'deepseek-chat', modelFallbacks: ['deepseek-chat'], enabled: true }],
    { enableProviderFallback: false, enableDecisionProviderFallback: false },
  )
  const stored = (app['providers'] as { providerId: string; apiKeyRef: string }[])[0]
  // docStudio semantics: the raw key is stored and echoed back as apiKeyRef.
  assert.equal(stored.apiKeyRef, 'sk-test')
  assert.equal(app['enableProviderFallback'], false)
  assert.equal(app['enableDecisionProviderFallback'], false)
  const all = getSettings()
  assert.deepEqual((all['provider_all'] as typeof app)['providers'], app['providers'])
  assert.deepEqual((all['provider_deepseek'] as { providerId: string }).providerId, 'deepseek')
})

test('single-key put/get/delete behaves like the settings table', () => {
  putSetting('sender_profile', { name: 'Ada' })
  assert.deepEqual(getSetting('sender_profile'), { name: 'Ada' })
  deleteSetting('sender_profile')
  assert.equal(getSetting('sender_profile'), null)
})

test('static model catalog covers providers with id metadata', () => {
  const catalog = getModelCatalog() as Record<string, { id: string }[]>
  for (const id of ['deepseek', 'gemini', 'kimi']) {
    assert.ok(Array.isArray(catalog[id]) && catalog[id].length > 0, id)
    for (const m of catalog[id]) assert.ok(typeof m.id === 'string' && m.id.length > 0)
  }
})

// ── 结构化输出能力登记：判定链能否「强制 JSON」取决于这一位 ──────────────────
// 判定链只对登记为支持结构化输出的模型发 response_format。登记错了会有两种后果：
// 该发没发（模型仍靠自觉，读数降级 needs-human）；不该发却发（不支持该字段的模型直接 400）。

test('dots-3 登记为支持结构化输出，带 :free 后缀走前缀匹配', () => {
  const exact = getModelCapabilities('dots-studio/dots-3-note-preview')
  assert.equal(exact.supportsStructuredOutput, true)
  assert.equal(exact.contextWindow, 512_000)
  assert.equal(exact.maxOutputTokens, 460_800)
  assert.equal(exact.supportsVision, true)

  const free = getModelCapabilities('dots-studio/dots-3-note-preview:free')
  assert.equal(free.supportsStructuredOutput, true, ':free 变体必须命中同一条目')
})

test('未登记的模型落到保守默认值：不支持结构化输出', () => {
  // nemotron 在 OpenRouter 上不提供 response_format；未登记就该按「不支持」处理，
  // 这样 llmClient 会丢弃该字段而不是发出去撞 400。
  assert.equal(getModelCapabilities('nvidia/nemotron-3-ultra-550b-a55b:free').supportsStructuredOutput, false)
  assert.equal(getModelCapabilities('some/unknown-model-xyz').supportsStructuredOutput, false)
})

test('nemotron-3-super-120b 登记为支持结构化输出，且不与旧条目串味', () => {
  const free = getModelCapabilities('nvidia/nemotron-3-super-120b-a12b:free')
  assert.equal(free.supportsStructuredOutput, true, '判定链要靠这一位才发 response_format')
  assert.equal(free.contextWindow, 262_144)
  assert.equal(free.maxOutputTokens, 235_929)
  assert.equal(free.supportsFunctionCalling, true)

  // 不带 :free 的同一型号走前缀匹配，能力必须一致
  assert.equal(getModelCapabilities('nvidia/nemotron-3-super-120b-a12b').supportsStructuredOutput, true)

  // 旧条目 "nemotron-3-super-free" 是另一个型号（OpenCode 托管），必须保持「不支持」，
  // 且不能被新条目的前缀匹配误伤。
  assert.equal(getModelCapabilities('nemotron-3-super-free').supportsStructuredOutput, false)
})

test('实测不可用的免费模型保持未登记 → 保守默认（不发 response_format）', () => {
  // liquid/lfm-2.5-2.6b 实测忽略 json_schema；apodex/apodex-1.1-mini 实测直接 400。
  // 两者都不登记，落到默认「不支持」，判定链因此不会把 response_format 发出去撞 400。
  assert.equal(getModelCapabilities('liquid/lfm-2.5-2.6b:free').supportsStructuredOutput, false)
  assert.equal(getModelCapabilities('apodex/apodex-1.1-mini:free').supportsStructuredOutput, false)
})
