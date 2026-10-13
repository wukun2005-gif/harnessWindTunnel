// Display names for harness configurations.
//
// Why this exists: a configuration is identified internally by a fingerprint
// (a short hash of its DSL fields), and that hash was leaking into the UI —
// the same configuration appeared as "C0" in one table and as a bare hash in
// another, because each view read the name off whichever run it happened to
// look at first (one view walks the list oldest-first, another newest-first).
//
// The fix is to stop reading the name off a run: the name is a property of the
// CONFIGURATION, resolved from the fingerprint itself. Every view then shows
// the same name for the same configuration by construction, and a run created
// by a new code path can never introduce a third spelling.
import type { DatabaseSync } from 'node:sqlite'
import { fingerprint } from '../../shared/config'
import { PG_PRESETS } from './presets'

/** Last-resort label for a configuration nobody has named. */
export function shortHash(fp: string): string {
  return fp.slice(0, 8)
}

export interface ConfigName {
  label: string
  /** Hover text when the short label is not self-explanatory. */
  title: string | null
}

export type ConfigNamer = (fp: string) => ConfigName

/**
 * Build the fingerprint → name resolver once per request. Reads the presets
 * (fixed) and the evolution version tree (small, ordered oldest-first so the
 * ordinals are stable).
 */
export function makeConfigNamer(db: DatabaseSync): ConfigNamer {
  const presetByFp = new Map<string, ConfigName>()
  for (const p of PG_PRESETS) {
    presetByFp.set(fingerprint(p.config), { label: p.id, title: null })
  }

  const evolvedByFp = new Map<string, ConfigName>()
  try {
    const rows = db
      .prepare('SELECT fingerprint, label FROM pg_evo_generations ORDER BY created_at ASC')
      .all() as Array<{ fingerprint: string; label: string }>
    let n = 0
    for (const row of rows) {
      // A generation whose config is byte-identical to a preset is that preset.
      if (presetByFp.has(row.fingerprint) || evolvedByFp.has(row.fingerprint)) continue
      n += 1
      evolvedByFp.set(row.fingerprint, { label: `Evolved #${n}`, title: row.label })
    }
  } catch {
    // Version tree absent (fresh database) — presets and hashes still resolve.
  }

  return (fp: string) => presetByFp.get(fp) ?? evolvedByFp.get(fp) ?? { label: shortHash(fp), title: null }
}
