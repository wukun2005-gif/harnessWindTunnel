import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deriveRun } from '../src/lib/derive'
import type { HarnessEvent } from '../shared/events'

const events = (scenario: string, file: string): HarnessEvent[] =>
  readFileSync(resolve('data/scenarios', scenario, 'branches', file), 'utf8')
    .trim().split('\n').map((line) => JSON.parse(line)) as HarnessEvent[]

test('failed run marks its earliest tagged step as critical', () => {
  const run = deriveRun(events('workflow-crm-export', 'base.jsonl'))
  assert.equal(run.finish?.success, false)
  assert.equal(run.criticalStep, 6)
})

test('successful run never marks a critical step, even with resolved tags', () => {
  const run = deriveRun(events('workflow-crm-export', 'filestate.jsonl'))
  assert.equal(run.finish?.success, true)
  assert.equal(run.criticalStep, null)
})

test('clean run without tags has no critical step', () => {
  const run = deriveRun(events('writing-q3-report', 'fivelayer.jsonl'))
  assert.equal(run.criticalStep, null)
})

test('research base run pins the earliest of several tags', () => {
  const run = deriveRun(events('research-competitor-scan', 'base.jsonl'))
  assert.equal(run.criticalStep, 2)
})

test('writing baseline pins the overflow step once it carries tags', () => {
  const run = deriveRun(events('writing-q3-report', 'nocomp.jsonl'))
  assert.equal(run.finish?.success, false)
  assert.equal(run.criticalStep, 4)
})
