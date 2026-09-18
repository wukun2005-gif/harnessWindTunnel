import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TRANSFER_CLEAR, transferModes } from '../src/lib/derive'
import type { HarnessEvent } from '../shared/events'

const events = (scenario: string, file: string): HarnessEvent[] =>
  readFileSync(resolve('data/scenarios', scenario, 'branches', file), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)) as HarnessEvent[]

test('base → fixed pair transfers tags into clear (resolved)', () => {
  const m = transferModes(
    events('workflow-crm-export', 'base.jsonl'),
    events('workflow-crm-export', 'filestate.jsonl'),
  )
  assert.equal(m.steps, 1)
  assert.equal(m.rows['scope-violation']?.[TRANSFER_CLEAR], 1)
  assert.equal(m.rows['reasoning-action-mismatch']?.[TRANSFER_CLEAR], 1)
  assert.ok(m.modes.includes(TRANSFER_CLEAR))
})

test('research pair resolves premature-victory and fabricated-citation', () => {
  const m = transferModes(
    events('research-competitor-scan', 'base.jsonl'),
    events('research-competitor-scan', 'verifier.jsonl'),
  )
  assert.equal(m.steps, 2)
  assert.equal(m.rows['premature-victory']?.[TRANSFER_CLEAR], 1)
  assert.equal(m.rows['fabricated-citation']?.[TRANSFER_CLEAR], 1)
})

test('same branch against itself lands fully on the diagonal', () => {
  const evs = events('writing-q3-report', 'budget.jsonl')
  const m = transferModes(evs, evs)
  for (const [from, tos] of Object.entries(m.rows)) {
    assert.deepEqual(Object.keys(tos), [from])
  }
  assert.equal(m.rows['context-loss']?.['context-loss'], 1)
  assert.equal(m.rows['long-horizon-decay']?.['long-horizon-decay'], 1)
})

test('untagged pairs yield an empty matrix', () => {
  const m = transferModes(
    events('workflow-crm-export', 'filestate.jsonl'),
    events('workflow-crm-export', 'tuned.jsonl'),
  )
  assert.equal(m.steps, 0)
  assert.deepEqual(m.modes, [])
})

test('shared modes pair diagonally first, leftovers go cross', () => {
  const tag = (step: number, mast: string) =>
    ({ type: 'failure.tag', step, mast } as unknown as HarnessEvent)
  const m = transferModes(
    [tag(1, 'scope-violation'), tag(1, 'weak-grounding')],
    [tag(1, 'scope-violation'), tag(2, 'long-horizon-decay')],
  )
  assert.equal(m.steps, 2)
  assert.equal(m.rows['scope-violation']?.['scope-violation'], 1)
  assert.equal(m.rows['weak-grounding']?.[TRANSFER_CLEAR], 1)
  assert.equal(m.rows[TRANSFER_CLEAR]?.['long-horizon-decay'], 1)
})
