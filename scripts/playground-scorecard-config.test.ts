// The scorecard's Harness-switch block must compare every column against the
// leftmost baseline, count a difference exactly once per switch, and treat the
// Playground-only mounts as first-class rows. These pin the arithmetic; the
// color and collapse behavior is only a rendering of this result.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cfg } from '../shared/config'
import type { PgMounts, RunDetail } from '../shared/playground'
import {
  buildScorecardConfig,
  diffOnlyGroups,
  type ScorecardCfgColumn,
} from '../src/screens/Playground/scorecardConfig'

function detail(config: RunDetail['config'], mounts: PgMounts = {}): RunDetail {
  // buildScorecardConfig reads only config + mounts; the rest of the run detail
  // is irrelevant to the comparison.
  return { config, mounts } as RunDetail
}

const l12: ScorecardCfgColumn[] = [
  { label: 'C0', detail: detail(cfg()) },
  {
    label: 'C2',
    detail: detail(cfg({ guides: 'domain-checklist', sensors: 'verifier', observability: 'trace+mast' }), {
      patentLawMcp: true,
    }),
  },
  {
    label: 'Evolved #1',
    detail: detail(cfg({ guides: 'domain-checklist', sensors: 'verifier' }), {
      customGuideText: 'Cite Patent Law Articles 26 and 50 for every claim objection.',
    }),
  },
  {
    label: 'Evolved #2',
    detail: detail(
      cfg({ permissions: 'deny-first', guides: 'domain-checklist', sensors: 'verifier' }),
      { customGuideText: 'Cite Patent Law Articles 26 and 50 for every claim objection.' },
    ),
  },
  {
    label: 'Evolved #3',
    detail: detail(cfg({ permissions: 'deny-first', globalPolicy: 'policy-enforced' }), {
      customGuideText: 'Check the statutory deadline before ruling on the review request.',
    }),
  },
]

test('every differing switch is counted once, against the leftmost column', () => {
  const diff = buildScorecardConfig(l12)
  // permissions, guides, sensors, globalPolicy, observability, MCP mount, guide text
  assert.equal(diff.diffCount, 7)
  assert.equal(diff.totalCount, 22, '20 switches + mount + custom guide')
  assert.equal(diff.refLabel, 'C0')
  assert.equal(diffOnlyGroups(diff).flatMap((g) => g.rows).length, 7)
  assert.deepEqual(
    diffOnlyGroups(diff).map((g) => g.id),
    ['safety', 'evolution', 'mounts'],
    'groups with no difference disappear entirely',
  )
})

test('the baseline column is never highlighted, even when its value is non-default', () => {
  const diff = buildScorecardConfig(l12)
  for (const group of diff.groups) {
    for (const row of group.rows) {
      assert.equal(row.cells[0].diff, false, `${row.id} marks its baseline cell as different`)
    }
  }
})

test('identical columns show zero differences and keep the guide row optional', () => {
  const diff = buildScorecardConfig([
    { label: 'A', detail: detail(cfg()) },
    { label: 'B', detail: detail(cfg()) },
  ])
  assert.equal(diff.diffCount, 0)
  assert.equal(diff.totalCount, 21, 'no custom guide row when every run omits it')
  assert.equal(diff.groups.find((g) => g.id === 'mounts')?.rows.length, 1)
  assert.deepEqual(diffOnlyGroups(diff), [])
})

test('two different guidance texts count as a difference even when every switch matches', () => {
  const diff = buildScorecardConfig([
    { label: 'A', detail: detail(cfg(), { customGuideText: 'one' }) },
    { label: 'B', detail: detail(cfg(), { customGuideText: 'two' }) },
  ])
  const guide = diff.groups.find((g) => g.id === 'mounts')?.rows.find((r) => r.kind === 'guide')
  assert.ok(guide)
  assert.equal(guide.anyDiff, true)
  assert.equal(diff.diffCount, 1)
  assert.equal(diff.totalCount, 22)
})

test('the guide cell previews long text but keeps the full value for its title', () => {
  const long = 'Keep every citation anchored to the claims as filed, and never invent an article number.'
  const diff = buildScorecardConfig([
    { label: 'A', detail: detail(cfg()) },
    { label: 'B', detail: detail(cfg(), { customGuideText: long }) },
  ])
  const guide = diff.groups.find((g) => g.id === 'mounts')?.rows.find((r) => r.kind === 'guide')!
  assert.equal(guide.cells[1].full, long)
  assert.equal(guide.cells[1].text.endsWith('…'), true)
  assert.ok(guide.cells[1].text.length <= 31)
  assert.equal(guide.cells[0].text, '', 'an absent guide stays empty, never "off"')
})
