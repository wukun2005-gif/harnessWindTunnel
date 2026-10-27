// Harness-switch differences inside the per-question scorecard.
//
// The scorecard compares configurations by score, but two columns scoring 0.76
// and 1.00 are not explained by the number itself. This module puts the 20 DSL
// switches — plus the two Playground-only mounts — side by side and marks every
// value that differs from the leftmost column. Kept pure so the row math is
// pinned by test instead of by reading the rendered table.
import { COMPONENT_GROUPS, type ConfigField } from '../../../shared/config'
import type { RunDetail } from '../../../shared/playground'

export interface ScorecardCfgColumn {
  label: string
  detail: RunDetail
}

export interface ScorecardCfgCell {
  /** Display text. Raw switch value, except the custom guide which is clipped. */
  text: string
  /** Untruncated value, for the hover title. */
  full: string
  /** True when this column differs from the leftmost (baseline) column. */
  diff: boolean
}

export interface ScorecardCfgRow {
  /** Config field name, or `mount:patentLawMcp` / `mount:customGuideText`. */
  id: string
  kind: 'field' | 'mount' | 'guide'
  cells: ScorecardCfgCell[]
  anyDiff: boolean
}

export interface ScorecardCfgGroup {
  id: 'runtime' | 'state' | 'safety' | 'evolution' | 'mounts'
  rows: ScorecardCfgRow[]
}

export interface ScorecardCfgDiff {
  /** Display name of the leftmost column every comparison is against. */
  refLabel: string
  groups: ScorecardCfgGroup[]
  diffCount: number
  totalCount: number
}

const GROUP_ID: Record<string, ScorecardCfgGroup['id']> = {
  'Runtime Core': 'runtime',
  'State & Memory': 'state',
  'Constraints & Safety': 'safety',
  'Evolution & Resilience': 'evolution',
}

/** Long enough to tell two guidance paragraphs apart, short enough for a cell. */
const GUIDE_PREVIEW = 30

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > GUIDE_PREVIEW ? `${flat.slice(0, GUIDE_PREVIEW)}…` : flat
}

function cellsFrom(raw: string[], clip = false): ScorecardCfgCell[] {
  return raw.map((value, i) => ({
    text: clip && value ? preview(value) : value,
    full: value,
    diff: i > 0 && value !== raw[0],
  }))
}

/**
 * Diff every switch against `columns[0]`.
 *
 * Caller must pass at least two columns with their details loaded: a missing
 * detail is not an unchanged switch, it is unknown, and guessing "same" is the
 * failure this whole card exists to avoid.
 */
export function buildScorecardConfig(columns: ScorecardCfgColumn[]): ScorecardCfgDiff {
  const ref = columns[0]
  const groups: ScorecardCfgGroup[] = COMPONENT_GROUPS.map((group) => ({
    id: GROUP_ID[group.group] ?? 'runtime',
    rows: group.fields.map((field) => {
      const cells = cellsFrom(columns.map((c) => String(c.detail.config[field as ConfigField])))
      return {
        id: field,
        kind: 'field' as const,
        cells,
        anyDiff: cells.some((c) => c.diff),
      }
    }),
  }))

  const mountCells = cellsFrom(columns.map((c) => (c.detail.mounts?.patentLawMcp ? 'on' : 'off')))
  const mountRow: ScorecardCfgRow = {
    id: 'mount:patentLawMcp',
    kind: 'mount',
    cells: mountCells,
    anyDiff: mountCells.some((c) => c.diff),
  }

  const guides = columns.map((c) => (c.detail.mounts?.customGuideText ?? '').trim())
  const hasGuide = guides.some((g) => g.length > 0)
  const guideCells = cellsFrom(guides, true)
  const mounts: ScorecardCfgRow[] = [mountRow]
  if (hasGuide) {
    mounts.push({
      id: 'mount:customGuideText',
      kind: 'guide',
      cells: guideCells,
      anyDiff: guideCells.some((c) => c.diff),
    })
  }
  groups.push({ id: 'mounts', rows: mounts })

  const allRows = groups.flatMap((g) => g.rows)
  return {
    refLabel: ref.label,
    groups,
    diffCount: allRows.filter((r) => r.anyDiff).length,
    totalCount: allRows.length,
  }
}

/** Drop unchanged rows so the default view only lists what actually differs. */
export function diffOnlyGroups(cfg: ScorecardCfgDiff): ScorecardCfgGroup[] {
  return cfg.groups
    .map((g) => ({ ...g, rows: g.rows.filter((r) => r.anyDiff) }))
    .filter((g) => g.rows.length > 0)
}
