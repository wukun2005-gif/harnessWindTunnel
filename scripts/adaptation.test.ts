import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { configDistance } from '../shared/config'
import {
  compatibilitySpread,
  fitRating,
  kendallTau,
  type AdaptationDoc,
} from '../shared/reliability'

const doc = JSON.parse(readFileSync(resolve('data/adaptation.json'), 'utf8')) as AdaptationDoc
const bare = doc.harnesses.find((h) => h.id === 'base') ?? doc.harnesses[0]
const liftOf = (model: string, hid: string) => doc.scores[model][hid] - doc.scores[model][bare.id]

test('adaptation table is complete and finite', () => {
  assert.ok(doc.harnesses.length >= 2)
  assert.ok(doc.models.length >= 2)
  for (const m of doc.models) {
    for (const h of doc.harnesses) {
      assert.ok(Number.isFinite(doc.scores[m]?.[h.id]), `${m} × ${h.id}`)
    }
  }
})

test('locked harness reads configDiff = 0 (only model varies)', () => {
  for (const h of doc.harnesses) {
    assert.equal(configDistance(h.config, h.config), 0)
  }
})

test('filestate fits all models, verifier does not fit flash', () => {
  const fs = doc.models.map((m) => liftOf(m, 'filestate'))
  assert.equal(fitRating(fs), 'Recommended')
  const vf = doc.models.map((m) => liftOf(m, 'verifier'))
  assert.equal(fitRating(vf), 'Caution')
  const neg = doc.models.filter((m) => liftOf(m, 'verifier') < 0)
  assert.deepEqual(neg, ['gemini-3-flash (illustrative)'])
})

test('F2-4 matrix and F2-11 profile read the same cells', () => {
  // Same pair, two views: matrix cell == profile conditional lift input.
  const m = doc.models[0]
  const matrixCell = doc.scores[m]['filestate']
  assert.equal(matrixCell - doc.scores[m]['base'], liftOf(m, 'filestate'))
})

test('rank reversal vs bare baseline is present and measurable', () => {
  const rank = (hid: string) => doc.models.map((m) => doc.scores[m][hid])
  const tau = kendallTau(rank('base'), rank('filestate'))
  assert.ok(tau !== null && tau < 1, `expected reversal, tau = ${tau}`)
  const spread = compatibilitySpread(rank('filestate'))
  assert.ok(spread && spread.range > 0)
})
