import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ABA_DUTIES, LEGAL_ASSERTIONS, LEGAL_CONTROLS, type LegalBundle } from '../shared/legal'
import { t } from '../src/i18n'

const bundle = {
  dossiers: (JSON.parse(readFileSync(resolve('data/domain/legal/dossiers.json'), 'utf8')) as { dossiers: LegalBundle['dossiers'] }).dossiers,
  staircase: JSON.parse(readFileSync(resolve('data/domain/legal/staircase.json'), 'utf8')) as LegalBundle['staircase'],
}

test('five dossiers: four booby plus one clean control', () => {
  assert.equal(bundle.dossiers.length, 5)
  const ids = bundle.dossiers.map((d) => d.id)
  assert.deepEqual(ids, ['mata-avianca', 'deadline-trap', 'jurisdiction-trap', 'figures-trap', 'clean-control'])
  for (const d of bundle.dossiers) {
    assert.ok(d.title && d.memo)
    assert.ok(d.assertions.length >= 4, d.id)
    for (const a of d.assertions) {
      assert.ok((LEGAL_ASSERTIONS as readonly string[]).includes(a.label), `${d.id}/${a.id}`)
      assert.ok(a.text && a.note)
    }
  }
})

test('mata dossier flags exactly six fabricated cases', () => {
  const mata = bundle.dossiers.find((d) => d.id === 'mata-avianca')!
  const flagged = mata.assertions.filter((a) => a.label === 'citation_unreachable' || a.label === 'unsupported')
  assert.equal(flagged.length, 6)
  assert.ok(flagged.every((a) => (a.aba ?? []).length > 0))
})

test('clean control carries zero flags', () => {
  const clean = bundle.dossiers.find((d) => d.id === 'clean-control')!
  assert.ok(clean.assertions.every((a) => a.label === 'supported'))
})

test('staircase improves monotonically to zero fake citations', () => {
  const seq = [bundle.staircase.states.bare, bundle.staircase.states['soft-cn'], bundle.staircase.states.hard]
  const seqUs = [bundle.staircase.states.bare, bundle.staircase.states['soft-us'], bundle.staircase.states.hard]
  for (const s of [seq, seqUs]) {
    assert.ok(s[0].fakeCiteRate > s[1].fakeCiteRate && s[1].fakeCiteRate > s[2].fakeCiteRate)
    assert.ok(s[0].ungroundedRate > s[1].ungroundedRate && s[1].ungroundedRate > s[2].ungroundedRate)
    assert.ok(s[0].strictPassRate < s[1].strictPassRate && s[1].strictPassRate < s[2].strictPassRate)
  }
  assert.equal(bundle.staircase.states.hard.fakeCiteRate, 0)
  assert.ok(bundle.staircase.references.length >= 4)
})

test('license duties reference real controls only', () => {
  assert.equal(ABA_DUTIES.length, 6)
  for (const d of ABA_DUTIES) {
    assert.ok(d.gates.length > 0, d.rule)
    for (const g of d.gates) {
      assert.ok((LEGAL_CONTROLS as readonly string[]).includes(g), `${d.rule}/${g}`)
    }
  }
})

test('every dynamic UI key resolves in both languages', () => {
  for (const lang of ['en', 'zh'] as const) {
    for (const label of LEGAL_ASSERTIONS) {
      const key = `legal.assert.${label}`
      assert.notEqual(t(key, lang), key, `${lang}:${key}`)
    }
    for (const key of ['legal.route.cn', 'legal.route.us']) {
      assert.notEqual(t(key, lang), key, `${lang}:${key}`)
    }
  }
})
