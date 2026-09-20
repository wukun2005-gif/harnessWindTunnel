import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fixture } from '../src/i18n'
import { deriveRun } from '../src/lib/derive'
import { COMPONENT_META } from '../shared/config'
import { PRESETS } from '../shared/presets'
import type { HarnessEvent } from '../shared/events'

// Every user-facing prose string rendered from English fixture data must carry
// a Chinese translation. Technical identifiers intentionally kept in English
// (shaper names, numeric compaction lines, benchmark slugs, framework names)
// are explicitly exempted.
const han = /\p{Script=Han}/u
const exempt = new Set<string>([
  'Shaper Fired', // shaper module name stays English (PRD glossary)
  'budget: 14800 → 13500 tk',
  'budget: 15100 → 13800 tk',
  'OWASP AST03 / AgentRedBench url_relay',
  'AgentRedBench destination_hijack / content_hijack',
  'Task Shield',
  'Constitutional Classifiers',
])
const missing: string[] = []
const check = (s: string) => {
  if (exempt.has(s)) return
  const zh = fixture(s, 'zh')
  if (zh === s || !han.test(zh)) missing.push(s)
}
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

test('all rendered fixture prose has Chinese translations', () => {
  // Replay-derived strings: thoughts, tool summaries, marker labels/details, previews.
  for (const metaPath of files(resolve('data/scenarios')).filter((p) => p.endsWith('meta.json'))) {
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
    for (const b of meta.branches.filter((x: { file?: string }) => x.file)) {
      const events = readFileSync(resolve(metaPath, '..', 'branches', b.file), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) as HarnessEvent[]
      const run = deriveRun(events)
      for (const s of run.steps) {
        check(s.thought)
        for (const tl of s.tools) if (tl.summary) check(tl.summary)
        for (const m of [...s.markers, ...s.tags]) { check(m.label); check(m.detail) }
        for (const blk of s.blocks) if (blk.preview) check(blk.preview)
      }
    }
  }

  // Legal dossiers + audit staircase.
  const dossiers = JSON.parse(readFileSync(resolve('data/domain/legal/dossiers.json'), 'utf8')).dossiers
  for (const d of dossiers) {
    check(d.title); check(d.memo)
    for (const a of d.assertions) { check(a.text); check(a.note) }
  }
  const staircase = JSON.parse(readFileSync(resolve('data/domain/legal/staircase.json'), 'utf8'))
  for (const r of staircase.references) check(r.name)

  // Security attacks + control ablation.
  for (const c of JSON.parse(readFileSync(resolve('data/redteam/attacks.json'), 'utf8')).cases) {
    check(c.title); check(c.tactic); check(c.mapping)
    for (const s of c.stages) check(s.note)
  }
  const controls = JSON.parse(readFileSync(resolve('data/redteam/controls.json'), 'utf8'))
  for (const p of controls.points) check(p.label)
  for (const s of controls.stories) check(s.text)
  for (const r of controls.references) check(r.name)

  // Evolution Forge generations.
  const forge = JSON.parse(readFileSync(resolve('data/forge/generations.json'), 'utf8'))
  for (const g of forge.gens) {
    check(g.cluster.summary); check(g.card.title); check(g.card.nl)
    check(g.card.surfaceReason); check(g.falsification.detail)
  }

  // Paper presets: titles, taglines, variant labels and prose notes.
  for (const p of PRESETS) {
    check(p.title); check(p.tagline)
    for (const v of p.variants) {
      check(v.label)
      // Pure numeric notes (e.g. "69.7%") are data, not prose.
      if (v.note && /[A-Za-z]{4}/.test(v.note)) check(v.note)
    }
  }

  // Adaptation profile: harness labels and model names.
  const adaptation = JSON.parse(readFileSync(resolve('data/adaptation.json'), 'utf8'))
  for (const h of adaptation.harnesses) check(h.label)
  for (const m of adaptation.models) check(m)

  // Module board evidence tooltips.
  for (const key of Object.keys(COMPONENT_META) as (keyof typeof COMPONENT_META)[]) {
    const evidence = COMPONENT_META[key].evidence
    if (evidence) check(evidence)
  }

  // Every source/provenance badge label found in data.
  const labels = new Set<string>()
  const visit = (v: unknown): void => {
    if (typeof v === 'string') return
    if (Array.isArray(v)) { v.forEach(visit); return }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.kind === 'string' && typeof o.label === 'string') labels.add(o.label)
      Object.values(o).forEach(visit)
    }
  }
  for (const p of files(resolve('data')).filter((x) => x.endsWith('.json'))) {
    visit(JSON.parse(readFileSync(p, 'utf8')))
  }
  for (const l of labels) {
    // Runtime-composed nearest-neighbor label uses an interpolated i18n key.
    if (!/^Approximate ·/.test(l)) check(l)
  }

  assert.deepEqual([...new Set(missing)].sort(), [], `Untranslated fixture prose:\n${[...new Set(missing)].sort().map((s) => `- ${JSON.stringify(s)}`).join('\n')}`)
})
