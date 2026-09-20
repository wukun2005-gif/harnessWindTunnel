import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CUSTOM_PRESET_ID,
  PRESET_PROVIDERS,
  trimBaseUrl,
} from '../shared/provider'
import { getModelCatalog } from '../server/providers/model-capabilities-registry'

process.env['HWT_SETTINGS_FILE'] = join(mkdtempSync(join(tmpdir(), 'hwt-settings-')), 'settings.json')
const { deleteSetting, getSetting, getSettings, putProviderBundle, putSetting } = await import('../server/settingsStore')

test('thirteen preset cards (12 vendors + custom), all well-formed', () => {
  assert.equal(PRESET_PROVIDERS.length, 13)
  const ids = PRESET_PROVIDERS.map((v) => v.id)
  assert.equal(new Set(ids).size, 13)
  assert.equal(CUSTOM_PRESET_ID, 'custom')
  for (const v of PRESET_PROVIDERS) {
    assert.ok(v.name && v.desc && v.keyPlaceholder, v.id)
    if (v.id !== CUSTOM_PRESET_ID) assert.ok(v.defaultBaseUrl.startsWith('https://'), v.id)
  }
})

test('baseUrl trimming strips whitespace and trailing slashes', () => {
  assert.equal(trimBaseUrl('https://x.example/v1///  '), 'https://x.example/v1')
  assert.equal(trimBaseUrl('https://x.example/v1'), 'https://x.example/v1')
})

test('settings store round-trips a provider bundle (provider_all + legacy rows)', () => {
  const app = putProviderBundle(
    [{ providerId: 'deepseek', apiKey: 'sk-test', baseUrl: 'https://api.deepseek.com/v1', modelIds: ['deepseek-chat'], defaultModelId: 'deepseek-chat', modelFallbacks: ['deepseek-chat'], enabled: true }],
    { enableProviderFallback: false },
  )
  const stored = (app['providers'] as { providerId: string; apiKeyRef: string }[])[0]
  // docStudio semantics: the raw key is stored and echoed back as apiKeyRef.
  assert.equal(stored.apiKeyRef, 'sk-test')
  assert.equal(app['enableProviderFallback'], false)
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
