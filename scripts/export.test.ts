import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cfg } from '../shared/config'
import { buildTunnelExport, parseTunnelImport } from '../src/lib/pack'

const variants = [
  { label: 'Bare', config: cfg() },
  { label: '+ File-backed State', config: cfg({ filesystem: 'file-backed-state' }), note: 'Δ +13.9pp' },
]

test('export → import round-trips variants and locked baseline', () => {
  const payload = buildTunnelExport('workflow-crm-export', variants, 'v2', ['v1', 'v2'])
  assert.equal(payload.version, 1)
  assert.equal(payload.lockedIndex, 1)
  const back = parseTunnelImport(JSON.parse(JSON.stringify(payload)))!
  assert.equal(back.scenarioId, 'workflow-crm-export')
  assert.equal(back.variants.length, 2)
  assert.deepEqual(back.variants[1].config, variants[1].config)
  assert.equal(back.variants[1].note, 'Δ +13.9pp')
  assert.equal(back.lockedIndex, 1)
})

test('unlocked export restores with null baseline', () => {
  const payload = buildTunnelExport('s', variants, null, ['v1', 'v2'])
  assert.equal(parseTunnelImport(payload)!.lockedIndex, null)
})

test('malformed payloads are rejected, never thrown', () => {
  for (const bad of [
    null, 42, 'x', [], {},
    { version: 2, kind: 'wind-tunnel-variants', scenarioId: 's', variants: [] },
    { version: 1, kind: 'other', scenarioId: 's', variants: [] },
    { version: 1, kind: 'wind-tunnel-variants', scenarioId: 's', variants: [] },
    { version: 1, kind: 'wind-tunnel-variants', scenarioId: 's', variants: [{ label: 'x' }] },
    { version: 1, kind: 'wind-tunnel-variants', scenarioId: 's', variants: [{ label: 'x', config: { loopControl: 'basic' } }] },
    { version: 1, kind: 'wind-tunnel-variants', scenarioId: 's', variants: [{ label: 'x', config: cfg() }], lockedIndex: 9 },
    { version: 1, kind: 'wind-tunnel-variants', scenarioId: 's', variants: new Array(65).fill({ label: 'x', config: cfg() }) },
  ]) {
    assert.equal(parseTunnelImport(bad), null, JSON.stringify(bad)?.slice(0, 60))
  }
})

test('export payload carries no secret-shaped fields', () => {
  const payload = buildTunnelExport('s', variants, null, ['v1', 'v2'])
  const s = JSON.stringify(payload).toLowerCase()
  for (const needle of ['apikey', 'api_key', 'secret', 'token', 'password', 'bearer']) {
    assert.ok(!s.includes(needle), needle)
  }
})
