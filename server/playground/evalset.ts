// Loads the 45-task live Playground eval set (3 domain files) for the
// patent judicial-review scenario. Data is pre-annotated gold (channel A);
// the deterministic scorer lives in ./scorer.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { EvalTask, PlaygroundTaskList, PgDomain, PgSplit } from '../../shared/playground'

export const SCENARIO_ID = 'cn-court-led-heatsink'
export const SCENARIO_NAME = '中国法院 · 专利司法卷宗审理（LED 相变散热模组案）'

const EVAL_FILES = ['evalset-general.json', 'evalset-legal.json', 'evalset-security.json']
const DOMAIN_ORDER: PgDomain[] = ['general', 'legal', 'security']
const SPLIT_ORDER: PgSplit[] = ['repair', 'gate', 'scorecard']

let cache: PlaygroundTaskList | null = null

export function loadEvalSet(): PlaygroundTaskList {
  if (cache) return cache
  const dir = path.resolve(process.cwd(), 'data', 'playground')
  const tasks: EvalTask[] = []
  for (const f of EVAL_FILES) {
    const raw = JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as { tasks: EvalTask[] }
    tasks.push(...raw.tasks)
  }
  // Signature tasks first, then split (repair→gate→scorecard), then domain, then id.
  tasks.sort((a, b) => {
    if (!!a.signature !== !!b.signature) return a.signature ? -1 : 1
    const si = SPLIT_ORDER.indexOf(a.split) - SPLIT_ORDER.indexOf(b.split)
    if (si !== 0) return si
    const di = DOMAIN_ORDER.indexOf(a.domain) - DOMAIN_ORDER.indexOf(b.domain)
    if (di !== 0) return di
    return a.id.localeCompare(b.id, 'en')
  })
  cache = { scenarioId: SCENARIO_ID, scenarioName: SCENARIO_NAME, total: tasks.length, tasks }
  return cache
}

export function getTask(id: string): EvalTask | undefined {
  return loadEvalSet().tasks.find((t) => t.id === id)
}
