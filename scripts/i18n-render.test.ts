import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Forge from '../src/screens/Forge'
import MRI from '../src/screens/MRI'
import WindTunnel from '../src/screens/WindTunnel'
import Settings from '../src/screens/Settings'
import Legal from '../src/screens/Legal'
import Security from '../src/screens/Security'
import { useApp, useForge, useRun, useTunnel } from '../src/stores'
import { useI18n, fixture } from '../src/i18n'
import { PRESETS } from '../shared/presets'
import type { ForgeData } from '../src/api'
import type { ScenarioMeta, HarnessEvent } from '../shared/events'
import { deriveRun } from '../src/lib/derive'

// SSR reads initial snapshots. Populate those explicitly, and restore them after
// the test. This checks real component output, not browser interactions/effects.
test('English component output: Forge generations and scenario replays', () => {
  const stores = [useApp, useForge, useRun, useTunnel, useI18n]
  const restore = stores.map((store) => {
    const initial = store.getInitialState()
    const before = { ...initial }
    return () => Object.assign(initial, before)
  })
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
  let renders = 0
  function check(component: () => ReactElement) {
    const html = renderToStaticMarkup(createElement(component))
    assert.ok(!/\p{Script=Han}|\uFFFD/u.test(html), `${component.name}: Chinese or replacement character in English output`)
    assert.ok(!/>(?:forge|mri|tunnel|scenario)\.[a-z][\w.-]*</.test(html), `${component.name}: unresolved translation key`)
    renders++
  }
  try {
    Object.assign(useI18n.getInitialState(), { lang: 'en' })
    const forge: ForgeData = json('data/forge/generations.json')
    const catalog: { scenarioId: string }[] = json('data/scenarios/index.json')
    const metas = Object.fromEntries(catalog.map(({ scenarioId }) => [scenarioId, json(`data/scenarios/${scenarioId}/meta.json`)])) as Record<string, ScenarioMeta>
    Object.assign(useApp.getInitialState(), { ready: true, online: true, forge, metas, scenarios: Object.values(metas) })
    for (const meta of Object.values(metas)) {
      Object.assign(useApp.getInitialState(), { current: meta.scenarioId })
      for (const branch of meta.branches.filter((b) => b.file)) {
        const events = readFileSync(`data/scenarios/${meta.scenarioId}/branches/${branch.file}`, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) as HarnessEvent[]
        Object.assign(useRun.getInitialState(), {
          run: deriveRun(events), playhead: events.length,
          meta: { runId: 'test', branchId: branch.branchId, source: { kind: 'fixture', label: 'Offline fixture' } },
        })
        check(MRI)
      }
    }
    Object.assign(useTunnel.getInitialState(), {
      variants: [{ key: 'test', label: '配置 1', config: useTunnel.getInitialState().config, color: '#fff' }],
    })
    check(WindTunnel)
    check(Settings)
    check(Legal)
    check(Security)
    for (const gen of forge.gens) {
      Object.assign(useForge.getInitialState(), { currentGen: gen.gen })
      check(Forge)
    }
    const recordedBranches = Object.values(metas).reduce((n, meta) => n + meta.branches.filter((b) => b.file).length, 0)
    assert.equal(renders, recordedBranches + forge.gens.length + 1 + 3)
    console.log(`Checked ${renders} English component renders`)
  } finally {
    restore.forEach((reset) => reset())
  }
})

// Chinese UI: chrome is translated, canonical English technical names never
// resurface as raw fixture prose, and no dotted key ever leaks to the markup.
test('Chinese component output: translated chrome and case prose', () => {
  const stores = [useApp, useForge, useRun, useTunnel, useI18n]
  const restore = stores.map((store) => {
    const initial = store.getInitialState()
    const before = { ...initial }
    return () => Object.assign(initial, before)
  })
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
  const unresolved = />(?:forge|mri|tunnel|scenario|legal|security|settings|common|sec|home|nav)\.[a-z][\w.-]*</
  // Canonical marker/MAST names that must never appear raw in Chinese markup.
  // 'Permission Gate' / 'Optimizer' are also module-board names kept English by
  // policy (⑪ / ⑳), so they are intentionally not asserted here.
  const rawEnglish = ['Premature Victory', 'Weak Grounding', 'Long-Horizon Decay', 'Spec Misinterpretation',
    'Fabricated Citation', 'Scope Violation', 'Step Repetition', 'Reasoning-Action Mismatch',
    'Unaware of Stopping', 'Task Derailment', 'Fail to Clarify', 'Context Loss',
    'Hook Intercept', 'Shaper Fired', 'Verifier Rejected', 'Verifier Passed',
    'Lint Rejected', 'Lint Passed', 'Agent Fork', 'Agent Join', 'Compaction Boundary',
    'MAST Failure Tag', 'SCREEN 01', 'SCREEN 02', 'SCREEN 03', 'STEP ']
  try {
    Object.assign(useI18n.getInitialState(), { lang: 'zh' })
    const forge: ForgeData = json('data/forge/generations.json')
    const catalog: { scenarioId: string }[] = json('data/scenarios/index.json')
    const metas = Object.fromEntries(catalog.map(({ scenarioId }) => [scenarioId, json(`data/scenarios/${scenarioId}/meta.json`)])) as Record<string, ScenarioMeta>
    Object.assign(useApp.getInitialState(), { ready: true, online: true, forge, metas, scenarios: Object.values(metas) })

    // MRI: every recorded branch renders in Chinese with no raw canonical labels.
    for (const meta of Object.values(metas)) {
      Object.assign(useApp.getInitialState(), { current: meta.scenarioId })
      for (const branch of meta.branches.filter((b) => b.file)) {
        const events = readFileSync(`data/scenarios/${meta.scenarioId}/branches/${branch.file}`, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) as HarnessEvent[]
        Object.assign(useRun.getInitialState(), {
          run: deriveRun(events), playhead: events.length,
          meta: { runId: 'test', branchId: branch.branchId, source: { kind: 'fixture', label: 'Offline fixture' } },
        })
        const html = renderToStaticMarkup(createElement(MRI))
        assert.ok(!unresolved.test(html), `MRI ${branch.branchId}: unresolved translation key`)
        assert.ok(html.includes('屏 01'), 'MRI: screen eyebrow missing')
        assert.ok(html.includes('过早胜利'), 'MRI: MAST legend not translated')
        for (const raw of rawEnglish) assert.ok(!html.includes(raw), `MRI ${branch.branchId}: raw English "${raw}"`)
      }
    }

    // WindTunnel: translated groups, preset buttons and preset variant labels/notes.
    const variants = PRESETS.flatMap((p, i) =>
      p.variants.map((v, j) => ({ key: `${p.id}-${j}`, label: v.label, config: useTunnel.getInitialState().config, color: '#fff', note: v.note })))
    Object.assign(useTunnel.getInitialState(), { variants })
    const tunnelHtml = renderToStaticMarkup(createElement(WindTunnel))
    assert.ok(!unresolved.test(tunnelHtml), 'WindTunnel: unresolved translation key')
    assert.ok(tunnelHtml.includes('运行内核'), 'WindTunnel: module group not translated')
    assert.ok(tunnelHtml.includes('NLAH 受控消融'), 'WindTunnel: preset title not translated')
    assert.ok(tunnelHtml.includes('Basic（裸基准）'), 'WindTunnel: preset variant label not translated')

    // Settings: eyebrow (provider table only renders after client-side fetch).
    const settingsHtml = renderToStaticMarkup(createElement(Settings))
    assert.ok(settingsHtml.includes('设置'), 'Settings: eyebrow not translated')

    // Legal / Security SSR show the loading state; it must be Chinese and key-free.
    for (const [Cmp, name] of [[Legal, 'Legal'], [Security, 'Security']] as [() => ReactElement, string][]) {
      const html = renderToStaticMarkup(createElement(Cmp))
      assert.ok(!unresolved.test(html), `${name}: unresolved translation key`)
      assert.ok(/\p{Script=Han}/u.test(html), `${name}: loading state not Chinese`)
    }

    // Forge: every generation card, cluster summary and verdict chip is Chinese.
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
    for (const gen of forge.gens) {
      Object.assign(useForge.getInitialState(), { currentGen: gen.gen })
      const html = renderToStaticMarkup(createElement(Forge))
      assert.ok(!unresolved.test(html), `Forge gen ${gen.gen}: unresolved translation key`)
      assert.ok(html.includes(esc(fixture(gen.card.title, 'zh'))), `Forge gen ${gen.gen}: card title not translated`)
      assert.ok(html.includes(esc(fixture(gen.cluster.summary, 'zh'))), `Forge gen ${gen.gen}: cluster summary not translated`)
      assert.ok(!html.includes(esc(gen.card.title)), `Forge gen ${gen.gen}: raw English card title`)
      assert.ok(html.includes('屏 03'), 'Forge: screen eyebrow missing')
    }
    console.log('Checked Chinese component renders for all branches and generations')
  } finally {
    restore.forEach((reset) => reset())
  }
})
