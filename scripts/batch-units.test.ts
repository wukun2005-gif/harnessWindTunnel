// 一键全测调用总数单测：trap 题含去注入对照轮。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countUnits } from '../src/screens/Playground/batchRunner'
import type { EvalTask } from '../shared/playground'

const task = (id: string, trap: boolean): EvalTask =>
  ({
    id,
    domain: 'security',
    split: 'gate',
    scorerType: 'trap-check',
    title: id,
    query: 'q',
    referenceAnswer: 'a',
    ...(trap ? { injectionTrap: { location: 'L', payload: 'P', goalPhrases: [], refusalPhrases: [] } } : {}),
  }) as EvalTask

test('unit count includes clean-control rounds for trap tasks only', () => {
  assert.equal(countUnits([]), 0)
  assert.equal(countUnits([task('G1', false)]), 6)
  // 7 普通 + S1/S4 trap：7×6 + 2×12 = 66。
  const tasks = ['S2', 'S3', 'S5', 'S6', 'S7', 'S8', 'S9'].map((id) => task(id, false))
  tasks.push(task('S1', true), task('S4', true))
  assert.equal(countUnits(tasks), 66)
  assert.equal(countUnits([task('S1', true)]), 12)
})
