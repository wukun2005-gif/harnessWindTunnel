import type { HarnessConfig } from '../shared/config'
import type { MetricsEntry, ReplayMeta, ScenarioMeta } from '../shared/events'
import { PRESETS, type Preset } from '../shared/presets'
import type { AdaptationDoc } from '../shared/reliability'
import type { LegalBundle } from '../shared/legal'

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
  return r.json() as Promise<T>
}

async function jpost<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) {
    let detail = `${r.status}`
    try {
      detail = (await r.json() as { error?: string }).error ?? detail
    } catch { /* keep status */ }
    throw new Error(detail)
  }
  return r.json() as Promise<T>
}

export interface ScenarioSummary {
  scenarioId: string
  family: string
  familyLabel: string
  task: string
  model: string
  traps: string[]
  branches: string[]
}

export type EditSurface = 'prompt' | 'middleware' | 'joint'
export interface ForgeGen {
  gen: number
  gain: number
  verdict: 'approved' | 'rejected'
  approvedBy: 'human' | 'autoplay-gate'
  cluster: { mast: string; count: number; summary: string; sampleBranches: string[] }
  card: { seam: string; title: string; nl: string; diff: string; surface: EditSurface; surfaceReason: string; prediction: { gainPp: [number, number] } }
  falsification: { rescued: number; regressed: number; detail: string }
}
export interface ForgeData {
  scenarioId: string
  startScore: number
  endScore: number
  gens: ForgeGen[]
  source: { kind: string; label: string; citation?: string }[]
}

export const api = {
  health: () => jget<{ ok: boolean; data: boolean }>('/api/health'),
  scenarios: () => jget<ScenarioSummary[]>('/api/scenarios'),
  scenario: (id: string) => jget<ScenarioMeta>(`/api/scenarios/${encodeURIComponent(id)}`),
  replayBranch: (scenarioId: string, branchId: string) =>
    jget<{ meta: ReplayMeta; events: unknown[] }>(`/api/replay.json?scenario=${encodeURIComponent(scenarioId)}&branch=${encodeURIComponent(branchId)}`),
  metrics: (scenarioId: string, config?: HarnessConfig) =>
    jget<Record<string, MetricsEntry> | { entry: MetricsEntry; exact: boolean; nearestFp?: string; distance?: number }>(
      `/api/metrics?scenario=${encodeURIComponent(scenarioId)}${config ? `&config=${encodeURIComponent(JSON.stringify(config))}` : ''}`,
    ),
  presets: () => Promise.resolve({ presets: PRESETS } as { presets: Preset[] }),
  forge: () => jget<ForgeData>('/api/forge'),
  adaptation: (scenarioId: string) =>
    jget<AdaptationDoc>(`/api/adaptation?scenario=${encodeURIComponent(scenarioId)}`),
  importEvents: (format: 'claude' | 'dsh', text: string) =>
    jpost<{ events: unknown[]; skipped: number }>('/api/import', { format, text }),
  importSample: (name: 'claude' | 'dsh') =>
    jget<{ name: string; text: string }>(`/api/import-sample?name=${name}`),
  nlahExport: (config: HarnessConfig, task: string) =>
    jpost<unknown>('/api/nlah/export', { config, task }),
  nlahImport: (doc: unknown) =>
    jpost<{ config: HarnessConfig; task: string }>('/api/nlah/import', { doc }),
  providerKey: (id: string, apiKey: string) =>
    jpost<{ ok: boolean; ref: string; hasKey: boolean }>('/api/provider-key', { id, apiKey }),
  providerKeyStatus: (id: string) =>
    jget<{ hasKey: boolean }>(`/api/provider-key-status?id=${encodeURIComponent(id)}`),
  providerModels: (baseUrl: string) =>
    jpost<{ models: string[]; simulated: boolean }>('/api/provider-models', { baseUrl }),
  legal: () => jget<LegalBundle>('/api/legal'),
}
