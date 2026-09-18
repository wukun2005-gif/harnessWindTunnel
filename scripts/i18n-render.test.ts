import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Demo from '../src/screens/Demo'
import Forge from '../src/screens/Forge'
import MRI from '../src/screens/MRI'
import WindTunnel from '../src/screens/WindTunnel'
import { useApp, useDemo, useForge, useRun, useTunnel } from '../src/stores'
import { useI18n } from '../src/i18n'
import type { ForgeData } from '../src/api'
import type { ScenarioMeta, HarnessEvent } from '../shared/events'
import { deriveRun } from '../src/lib/derive'

// SSR reads initial snapshots. Populate those explicitly, and restore them after
// the test. This checks real component output, not browser interactions/effects.
test('English component output: all demo steps, Forge generations, and scenario replays', () => {
  const stores = [useApp, useDemo, useForge, useRun, useTunnel, useI18n]
  const restore = stores.map((store) => {
    const initial = store.getInitialState()
    const before = { ...initial }
    return () => Object.assign(initial, before)
  })
  const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))
  let renders = 0
  function check(component: typeof Demo) {
    const html = renderToStaticMarkup(createElement(component))
    assert.ok(!/\p{Script=Han}|\uFFFD/u.test(html), `${component.name}: Chinese or replacement character in English output`)
    assert.ok(!/>(?:demo|forge|mri|tunnel|scenario)\.[a-z][\w.-]*</.test(html), `${component.name}: unresolved translation key`)
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
    for (let step = 0; step < 12; step++) {
      Object.assign(useDemo.getInitialState(), { step })
      check(Demo)
    }
    for (const gen of forge.gens) {
      Object.assign(useForge.getInitialState(), { currentGen: gen.gen })
      check(Forge)
    }
    const recordedBranches = Object.values(metas).reduce((n, meta) => n + meta.branches.filter((b) => b.file).length, 0)
    assert.equal(renders, recordedBranches + 12 + forge.gens.length + 1)
    console.log(`Checked ${renders} English component renders`)
  } finally {
    restore.forEach((reset) => reset())
  }
})
