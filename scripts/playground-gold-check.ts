// One-off gold self-check for the 45-task Playground eval set (M1).
// Validates: schema/counts, reference answers must score success, every
// articleKeyword must exist in the located statute text, signature bad
// answers must fail. Run from repo root: npx tsx scripts/playground-gold-check.ts
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { EvalTask } from '../shared/playground'
import { scoreAnswer, makeBadAnswer } from '../server/playground/scorer'
import { locateArticle, resetLawDocCache } from '../server/playground/articles'

const root = process.cwd()
const files = ['evalset-general.json', 'evalset-legal.json', 'evalset-security.json']
const tasks: EvalTask[] = []
for (const f of files) {
  const j = JSON.parse(readFileSync(path.join(root, 'data/playground', f), 'utf-8'))
  tasks.push(...j.tasks)
}

let failures = 0
const err = (msg: string) => { console.error('  ✗ ' + msg); failures++ }

// counts
const byDomain = { general: 0, legal: 0, security: 0 } as Record<string, number>
const bySplit = { repair: 0, gate: 0, scorecard: 0 } as Record<string, number>
const ids = new Set<string>()
for (const t of tasks) {
  byDomain[t.domain]++
  bySplit[t.split]++
  if (ids.has(t.id)) err(`duplicate id ${t.id}`)
  ids.add(t.id)
}
console.log(`loaded ${tasks.length} tasks; domain`, byDomain, '; split', bySplit)
if (tasks.length !== 45) err(`expected 45 tasks, got ${tasks.length}`)
if (byDomain.general !== 15) err(`general=${byDomain.general} != 15`)
if (byDomain.legal !== 21) err(`legal=${byDomain.legal} != 21`)
if (byDomain.security !== 9) err(`security=${byDomain.security} != 9`)
if (bySplit.repair !== 21) err(`repair=${bySplit.repair} != 21`)
if (bySplit.gate !== 15) err(`gate=${bySplit.gate} != 15`)
if (bySplit.scorecard !== 9) err(`scorecard=${bySplit.scorecard} != 9`)

// signature tasks pinned: G1-3 L1-3 S1-3
const sig = tasks.filter((t) => t.signature).map((t) => t.id).sort()
console.log('signature:', sig.join(','))
for (const expect of ['G1', 'G2', 'G3', 'L1', 'L2', 'L3', 'S1', 'S2', 'S3']) {
  const t = tasks.find((x) => x.id === expect)!
  if (!t) err(`missing signature ${expect}`)
  else if (t.split !== 'repair') err(`signature ${expect} not in repair split`)
}

resetLawDocCache()

for (const t of tasks) {
  // 1) reference answer must pass
  const r = scoreAnswer(t, t.referenceAnswer)
  if (!r.success) {
    err(`[${t.id}] reference answer NOT success (score ${r.score}) — ${r.summary}`)
    for (const fc of r.factChecks.filter((c) => !c.hit)) console.error(`      fact miss ${fc.id}: ${fc.missingTerms.join(' / ')}`)
    for (const ac of r.articleChecks.filter((c) => c.assertion !== 'supported')) console.error(`      article ${ac.id}: ${ac.assertion} — ${ac.detail}`)
    for (const sc of r.securityChecks.filter((c) => !c.passed)) console.error(`      security ${sc.kind}: ${sc.detail} [${sc.hits.join(',')}]`)
    if (r.antiHallucination && !r.antiHallucination.recognized) console.error(`      antiHall: ${r.antiHallucination.detail}`)
  }

  // 2) every expected article must exist and contain its articleKeywords
  for (const exp of t.expectedArticles ?? []) {
    const loc = locateArticle({ law: exp.law, article: exp.article, clause: exp.clause, section: exp.section })
    if (!loc) { err(`[${t.id}] ${exp.id} cannot locate ${exp.label}`); continue }
  }

  // 3) signature bad answers must fail
  if (t.signature) {
    const bad = makeBadAnswer(t)
    const rb = scoreAnswer(t, bad)
    if (rb.success) err(`[${t.id}] signature BAD answer incorrectly scored success`)
  }
}

if (failures === 0) {
  console.log('\n✅ ALL GOLD CHECKS PASSED — 45 tasks, reference answers pass, bad signature answers fail.')
} else {
  console.error(`\n❌ ${failures} gold check failure(s).`)
  process.exit(1)
}
