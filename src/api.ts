import type { HarnessConfig } from '../shared/config'
import type { MetricsEntry, ReplayMeta, ScenarioMeta } from '../shared/events'
import { PRESETS, type Preset } from '../shared/presets'

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url} → ${r.status}`)
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

export interface ForgeGen {
  gen: number
  gain: number
  verdict: 'approved' | 'rejected'
  approvedBy: 'human' | 'autoplay-gate'
  cluster: { mast: string; count: number; summary: string; sampleBranches: string[] }
  card: { seam: string; title: string; nl: string; diff: string; prediction: { gainPp: [number, number] } }
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
}
