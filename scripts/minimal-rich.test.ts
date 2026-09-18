import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cfg, configDistance } from '../shared/config'
import { PRESETS } from '../shared/presets'
import { getScenario, metricsForConfig } from '../server/replayer'

const SID = 'workflow-crm-export'

test('F2-10 pair branches exist with exact metrics', () => {
  const meta = getScenario(SID)
  for (const b of ['tools-rich', 'prompt-long', 'sustain']) {
    const branch = meta.branches.find((x) => x.branchId === b)
    assert.ok(branch, b)
    assert.ok(branch.file === '', `${b} is metrics-only`)
    const r = metricsForConfig(SID, branch.config)
    assert.equal(r.exact, true, `${b} resolves exactly`)
  }
})

test('each F2-10 pair varies exactly one field vs base', () => {
  const base = cfg()
  for (const c of [cfg({ toolset: 'extended' }), cfg({ guides: 'style-rules' }), cfg({ compression: 'five-layer' })]) {
    assert.equal(configDistance(base, c), 1)
  }
})

test('minimal-rich preset carries all six variants with exact readings', () => {
  const p = PRESETS.find((x) => x.id === 'minimal-rich-pairs')
  assert.ok(p)
  assert.equal(p.variants.length, 6)
  assert.equal(p.scenarioId, SID)
  for (const v of p.variants) {
    const r = metricsForConfig(SID, v.config)
    assert.equal(r.exact, true, v.label)
  }
})
