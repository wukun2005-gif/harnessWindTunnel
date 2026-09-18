import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const forge = JSON.parse(readFileSync(resolve('data/forge/generations.json'), 'utf8')) as {
  gens: { gen: number; card: { surface: string; surfaceReason: string; seam: string } }[]
}

test('every change card carries a valid PRISM edit surface and reason', () => {
  assert.equal(forge.gens.length, 9)
  for (const g of forge.gens) {
    assert.ok(['prompt', 'middleware', 'joint'].includes(g.card.surface), `gen ${g.gen}`)
    assert.ok(g.card.surfaceReason.length > 0, `gen ${g.gen}`)
  }
})

test('routing covers all three surfaces', () => {
  const got = new Set(forge.gens.map((g) => g.card.surface))
  assert.deepEqual([...got].sort(), ['joint', 'middleware', 'prompt'])
})
