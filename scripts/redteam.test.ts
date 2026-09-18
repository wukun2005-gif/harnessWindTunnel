import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { paretoFrontier } from '../shared/reliability'
import {
  HONESTY_NOTE,
  KILL_CHAIN,
  SECURITY_CONTROLS,
  type RedteamBundle,
} from '../shared/redteam'

const bundle = {
  attacks: (JSON.parse(readFileSync(resolve('data/redteam/attacks.json'), 'utf8')) as { cases: RedteamBundle['attacks'] }).cases,
  controls: JSON.parse(readFileSync(resolve('data/redteam/controls.json'), 'utf8')) as RedteamBundle['controls'],
}

test('attack library covers the full kill chain with valid stages', () => {
  assert.ok(bundle.attacks.length >= 4)
  for (const c of bundle.attacks) {
    assert.ok(c.title && c.tactic && c.mapping)
    assert.deepEqual(c.stages.map((s) => s.stage), [...KILL_CHAIN])
    for (const s of c.stages) {
      assert.ok(s.status === 'blocked' || s.status === 'breached')
      assert.ok(s.note)
    }
    assert.ok(c.blastRadius.length > 0, c.id)
  }
})

test('o3 case proves internal controls bypassable, chokepoint holds', () => {
  const o3 = bundle.attacks.find((c) => c.id === 'o3-killscript')!
  const action = o3.stages.find((s) => s.stage === 'action-execution')!
  const exfil = o3.stages.find((s) => s.stage === 'exfiltration')!
  assert.equal(action.status, 'breached')
  assert.equal(exfil.status, 'blocked')
})

test('ablation points use real controls with valid ranges', () => {
  assert.ok(bundle.controls.points.length >= 6)
  for (const p of bundle.controls.points) {
    assert.ok(p.asr >= 0 && p.asr <= 100, p.id)
    assert.ok(p.utility >= 0 && p.utility <= 100, p.id)
    assert.ok(p.friction >= 0 && p.friction <= 100, p.id)
    for (const c of p.controls) {
      assert.ok((SECURITY_CONTROLS as readonly string[]).includes(c), `${p.id}/${c}`)
    }
  }
  for (const s of bundle.controls.stories) {
    assert.ok(bundle.controls.points.some((p) => p.id === s.point), s.id)
  }
})

test('frontier is computed: extremes survive, full-seven is dominated', () => {
  const front = paretoFrontier(bundle.controls.points, [(p) => p.asr, (p) => 100 - p.utility, (p) => p.friction])
  const ids = front.map((p) => p.id)
  assert.ok(ids.includes('bare'), 'utility extreme survives')
  assert.ok(ids.includes('confirm-all'), 'asr extreme survives')
  assert.ok(ids.includes('leastpriv-dlp'))
  assert.ok(!ids.includes('full'), 'full seven costs more on every axis than gated')
  assert.ok(ids.length >= 3)
  // Every off-frontier point really is dominated by some frontier point.
  for (const p of bundle.controls.points) {
    if (ids.includes(p.id)) continue
    const dom = front.some((f) => f.asr <= p.asr && f.utility >= p.utility && f.friction <= p.friction
      && (f.asr < p.asr || f.utility > p.utility || f.friction < p.friction))
    assert.ok(dom, `${p.id} is dominated`)
  }
})

test('honesty note is present and non-empty', () => {
  assert.ok(HONESTY_NOTE.length > 0)
})
