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
import { getModelCatalog } from '../server/providers/model-capabilities-registry'

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
