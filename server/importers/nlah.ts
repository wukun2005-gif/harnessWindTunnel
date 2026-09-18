// F4-5: NLAH harness bidirectional mapping (HarnessConfig ⇄ NLAH JSON).
// The NLAH document shape is defined here and versioned; values are validated
// against the canonical 20-field DSL so export→import round-trips exactly.
import { COMPONENT_META, CONFIG_FIELDS, type HarnessConfig } from '../../shared/config'

export const NLAH_FORMAT = 'nlah-harness/1'

export interface NlahDoc {
  format: string
  task: string
  modules: Record<string, string>
  exportedAt?: string
}

export function exportNlah(config: HarnessConfig, task: string): NlahDoc {
  const modules: Record<string, string> = {}
  for (const k of CONFIG_FIELDS) modules[k] = config[k]
  return { format: NLAH_FORMAT, task, modules, exportedAt: new Date().toISOString() }
}

/** Strict parse: unknown format, missing fields, or off-spectrum values reject. */
export function importNlah(doc: unknown): { config: HarnessConfig; task: string } {
  if (typeof doc !== 'object' || doc === null) throw new Error('NLAH document must be an object')
  const d = doc as Record<string, unknown>
  if (d['format'] !== NLAH_FORMAT) throw new Error(`unsupported NLAH format (want ${NLAH_FORMAT})`)
  if (typeof d['task'] !== 'string' || !d['task']) throw new Error('NLAH document needs a task')
  if (typeof d['modules'] !== 'object' || d['modules'] === null) throw new Error('NLAH document needs modules')
  const modules = d['modules'] as Record<string, unknown>
  const config = {} as Record<string, string>
  for (const k of CONFIG_FIELDS) {
    const v = modules[k]
    const allowed = COMPONENT_META[k].options.map((o) => o.value)
    if (typeof v !== 'string' || !allowed.includes(v)) {
      throw new Error(`NLAH module ${k} missing or off-spectrum: ${String(v)}`)
    }
    config[k] = v
  }
  return { config: config as unknown as HarnessConfig, task: d['task'] as string }
}
