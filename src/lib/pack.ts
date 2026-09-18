import { CONFIG_FIELDS, type HarnessConfig } from '../../shared/config'

export const TUNNEL_EXPORT_VERSION = 1

export interface TunnelExportVariant {
  label: string
  config: HarnessConfig
  note?: string
}

export interface TunnelExport {
  version: number
  kind: 'wind-tunnel-variants'
  scenarioId: string
  exportedAt: string
  variants: TunnelExportVariant[]
  /** Index into variants; null = first row acts as baseline. */
  lockedIndex: number | null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isHarnessConfig(v: unknown): v is HarnessConfig {
  if (!isRecord(v)) return false
  return CONFIG_FIELDS.every((k) => typeof v[k] === 'string')
}

/** Build a portable export payload from live tunnel state (never includes secrets: none exist in this shape). */
export function buildTunnelExport(
  scenarioId: string,
  variants: { label: string; config: HarnessConfig; note?: string }[],
  lockedKey: string | null,
  keysInOrder: string[],
): TunnelExport {
  const idx = lockedKey ? keysInOrder.indexOf(lockedKey) : -1
  return {
    version: TUNNEL_EXPORT_VERSION,
    kind: 'wind-tunnel-variants',
    scenarioId,
    exportedAt: new Date().toISOString(),
    variants: variants.map((v) => ({ label: v.label, config: { ...v.config }, ...(v.note ? { note: v.note } : {}) })),
    lockedIndex: idx >= 0 ? idx : null,
  }
}

/** Validate an imported payload; null = rejected (never throws). */
export function parseTunnelImport(data: unknown): { scenarioId: string; variants: TunnelExportVariant[]; lockedIndex: number | null } | null {
  try {
    if (!isRecord(data)) return null
    if (data['version'] !== TUNNEL_EXPORT_VERSION || data['kind'] !== 'wind-tunnel-variants') return null
    if (typeof data['scenarioId'] !== 'string' || !Array.isArray(data['variants'])) return null
    const variants: TunnelExportVariant[] = []
    for (const v of data['variants'] as unknown[]) {
      if (!isRecord(v) || typeof v['label'] !== 'string' || !isHarnessConfig(v['config'])) return null
      variants.push({
        label: v['label'],
        config: v['config'],
        ...(typeof v['note'] === 'string' ? { note: v['note'] } : {}),
      })
    }
    if (variants.length === 0 || variants.length > 64) return null
    const li = data['lockedIndex']
    const lockedIndex = li === null || li === undefined ? null : typeof li === 'number' && Number.isInteger(li) && li >= 0 && li < variants.length ? li : null
    if (li !== null && li !== undefined && lockedIndex === null) return null
    return { scenarioId: data['scenarioId'] as string, variants, lockedIndex }
  } catch {
    return null
  }
}

/** Trigger a browser download of a JSON payload. */
export function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
