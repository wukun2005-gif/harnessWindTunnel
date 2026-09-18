import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CUSTOM_PRESET_ID,
  VENDOR_PRESETS,
  blankConnection,
  customPreset,
  trimBaseUrl,
} from '../shared/provider'
import { getKey, hasKey, keyCount, setKey } from '../server/keyStore'

test('twelve vendor presets plus custom, all well-formed', () => {
  assert.equal(VENDOR_PRESETS.length, 12)
  const ids = VENDOR_PRESETS.map((v) => v.id)
  assert.equal(new Set(ids).size, 12)
  for (const v of VENDOR_PRESETS) {
    assert.ok(v.name && v.keyPlaceholder)
    assert.ok(v.baseUrl.startsWith('https://'), v.id)
    assert.ok(v.models.length > 0, v.id)
  }
  assert.equal(CUSTOM_PRESET_ID, 'custom')
})

test('blank connections default sanely with no key reference', () => {
  const c = blankConnection(VENDOR_PRESETS[0])
  assert.equal(c.vendorId, VENDOR_PRESETS[0].id)
  assert.equal(c.defaultModel, VENDOR_PRESETS[0].models[0])
  assert.deepEqual(c.fallback, VENDOR_PRESETS[0].models.slice(1))
  assert.equal(c.apiKeyRef, null)
  assert.equal(c.enabled, true)
  const custom = blankConnection(customPreset('https://gw.example/v1'))
  assert.ok(custom.id.startsWith('custom-'))
})

test('baseUrl trimming strips whitespace and trailing slashes', () => {
  assert.equal(trimBaseUrl('https://x.example/v1///  '), 'https://x.example/v1')
  assert.equal(trimBaseUrl('https://x.example/v1'), 'https://x.example/v1')
})

test('keyStore isolates secrets per provider and never enumerates', async () => {
  assert.equal(hasKey('nope'), false)
  const before = keyCount()
  const ref = setKey('p1', 'sk-secret-1')
  assert.equal(ref, 'key_p1')
  assert.equal(hasKey('p1'), true)
  assert.equal(getKey('p1'), 'sk-secret-1')
  assert.equal(hasKey('p2'), false)
  setKey('p1', '')
  assert.equal(hasKey('p1'), false)
  assert.equal(keyCount(), before)
  // No listing API exists on the module surface.
  const fns = ['setKey', 'hasKey', 'getKey', 'keyCount', 'keyRefFor'].sort()
  assert.deepEqual(Object.keys(await import('../server/keyStore')).sort(), fns)
})
