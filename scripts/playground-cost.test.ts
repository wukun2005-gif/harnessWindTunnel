// Provider × model price table (design §11.2). The rule the whole cost column
// hangs on: cost is token × rate, computed at read time, and an unknown model
// yields an empty cost — never an invented number.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BLEND_INPUT_SHARE,
  avgCostUsd,
  estimateCostUsd,
  lookupRate,
} from '../server/playground/costTable'

test('exact model rates win over the provider default', () => {
  const r = lookupRate('deepseek', 'deepseek-chat')
  assert.deepEqual(r, { inputPerMTok: 0.27, outputPerMTok: 1.1 })
  assert.notDeepEqual(r, lookupRate('deepseek', 'some-other-model'))
})

test('prefix matching is longest-first, so gemini-2.5-pro does not fall back to 1.5', () => {
  const pro = lookupRate('gemini', 'gemini-2.5-pro')
  assert.deepEqual(pro, { inputPerMTok: 1.25, outputPerMTok: 10.0 })
  const flash = lookupRate('gemini', 'gemini-2.5-flash')
  assert.deepEqual(flash, { inputPerMTok: 0.15, outputPerMTok: 0.6 })
})

test('unknown provider or missing provider has no price — cost stays empty', () => {
  assert.equal(lookupRate('totally-unknown-provider', 'x'), null)
  assert.equal(lookupRate(null, 'deepseek-chat'), null)
  assert.equal(estimateCostUsd({ providerId: 'totally-unknown-provider', model: 'x', tokens: 10_000 }), null)
})

test('unknown model inside a known provider falls back to the provider default', () => {
  const r = lookupRate('deepseek', 'deepseek-new-thing')
  assert.deepEqual(r, { inputPerMTok: 0.28, outputPerMTok: 0.42 })
})

test('total tokens are blended 70/30 when no prompt/completion split exists', () => {
  // 1M total → 700k input + 300k output, deepseek-chat 0.27/1.1.
  const usd = estimateCostUsd({ providerId: 'deepseek', model: 'deepseek-chat', tokens: 1_000_000 })
  const expected = BLEND_INPUT_SHARE * 0.27 + (1 - BLEND_INPUT_SHARE) * 1.1
  assert.ok(usd != null)
  assert.ok(Math.abs(usd - expected) < 1e-6, `${usd} vs ${expected}`)
})

test('an explicit prompt/completion split is used verbatim', () => {
  const usd = estimateCostUsd({
    providerId: 'deepseek',
    model: 'deepseek-chat',
    promptTokens: 1_000_000,
    completionTokens: 1_000_000,
  })
  assert.ok(usd != null)
  assert.ok(Math.abs(usd - (0.27 + 1.1)) < 1e-6)
})

test('no tokens and negative token counts produce no cost', () => {
  assert.equal(estimateCostUsd({ providerId: 'deepseek', tokens: null }), null)
  assert.equal(estimateCostUsd({ providerId: 'deepseek', tokens: -5 }), null)
})

test('averaging skips unpriced runs and is null when nothing is priced', () => {
  assert.equal(avgCostUsd([null, undefined]), null)
  assert.equal(avgCostUsd([]), null)
  assert.equal(avgCostUsd([0.2, null, 0.4]), 0.3)
})
