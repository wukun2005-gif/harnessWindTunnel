import type { HarnessConfig } from '../shared/config'
import type { MetricsEntry, ReplayMeta, ScenarioMeta } from '../shared/events'
import { PRESETS, type Preset } from '../shared/presets'
import type { AdaptationDoc } from '../shared/reliability'
import type { LegalBundle } from '../shared/legal'
import type { RedteamBundle } from '../shared/redteam'
import type { ModelInfo, ProviderConfig } from '../shared/provider'
import type { JevJudgeResult, JevReviewRecord, JevSettingsPatch, JevSettingsView } from '../shared/jev'
import type { KnowledgeConfig, KnowledgeProviderType } from '../shared/knowledge'
import type { RetrievalSettingsView, SearchProviderId } from '../shared/search'
import type {
  PlaygroundTaskList,
  EvalTask,
  ScoreResult,
  PgPreset,
  RunTargets,
  RunSummary,
  RunDetail,
  LiveMetrics,
  CreateRunsRequest,
  PlaygroundRunFile,
  EvoAnalysis,
  EvoState,
  ApplyResult,
} from '../shared/playground'

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
  // ---- Provider settings (docStudio shape: { ok, ... }) ----
  settings: () =>
    jget<{ ok: boolean; settings: Record<string, unknown> }>('/api/settings'),
  settingsProviders: (
    providers: ProviderConfig[],
    flags: { enableProviderFallback?: boolean; enableDecisionProviderFallback?: boolean } = {},
  ) => jpost<{ ok: boolean }>('/api/settings/providers', { providers, ...flags }),
  modelCatalog: () =>
    jget<{ ok: boolean; catalog: Record<string, ModelInfo[]> }>('/api/providers/models'),
  queryModels: (providerId: string, apiKey: string, baseUrl: string) =>
    jpost<{ ok: boolean; providerId: string; models: string[]; error?: string }>(
      `/api/providers/${encodeURIComponent(providerId)}/models`, { apiKey, baseUrl }),
  verifyModel: (providerId: string, apiKey: string, baseUrl: string, modelId: string) =>
    jpost<{ ok: boolean; modelId: string; error?: string }>(
      `/api/providers/${encodeURIComponent(providerId)}/verify-model`, { apiKey, baseUrl, modelId }),
  legal: () => jget<LegalBundle>('/api/legal'),
  redteam: () => jget<RedteamBundle>('/api/redteam'),
  // ---- Knowledge base / retrieval settings / Search API (patentExaminator port) ----
  retrievalSettings: () =>
    jget<{ ok: boolean; settings: RetrievalSettingsView }>('/api/retrieval/settings'),
  saveRetrievalSettings: (patch: {
    knowledge?: Partial<KnowledgeConfig>
    knowledgeProviders?: Array<{
      providerType: KnowledgeProviderType
      providerId: string
      baseUrl?: string
      modelId?: string
      enabled?: boolean
      apiKey?: string
      clearKey?: boolean
    }>
    searchProviders?: Array<{
      providerId: SearchProviderId
      baseUrl?: string
      enabled?: boolean
      apiKey?: string
      clearKey?: boolean
    }>
  }) =>
    fetch('/api/retrieval/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(async (r) => {
      const data = (await r.json()) as { ok: boolean; settings: RetrievalSettingsView; error?: string }
      if (!r.ok || !data.ok || !data.settings) throw new Error(data.error ?? `PUT /api/retrieval/settings → ${r.status}`)
      return data as { ok: boolean; settings: RetrievalSettingsView }
    }),
  testKnowledgeProvider: (providerType: KnowledgeProviderType, baseUrl: string, apiKey: string, modelId: string) =>
    jpost<{ ok: boolean; error?: string }>('/api/knowledge/providers/test', { providerType, baseUrl, apiKey, modelId }),
  knowledgeSources: () =>
    jget<{ ok: boolean; sources: Array<{ id: string; name: string; type: string; format: string; mediaType: string; size: number; fileHash: string | null; sourceUrl: string | null; chunkCount: number; embedStatus: string; createdAt: string }> }>('/api/knowledge/sources'),
  knowledgeStats: () =>
    jget<{ ok: boolean; sourceCount: number; chunkCount: number; embeddedCount: number }>('/api/knowledge/stats'),
  knowledgeSearch: (query: string, topK?: number) =>
    jpost<{ ok: boolean; results?: Array<{ chunkId: string; text: string; score: number; metadata: Record<string, unknown> }>; error?: string }>('/api/knowledge/search', { query, topK }),
  knowledgeSourceChunks: (id: string, limit = 20) =>
    jget<{ ok: boolean; chunks: Array<{ id: string; index: number; text: string; metadata: Record<string, unknown> }> }>(`/api/knowledge/sources/${encodeURIComponent(id)}/chunks?limit=${limit}`),
  deleteKnowledgeSource: (id: string) =>
    fetch(`/api/knowledge/sources/${encodeURIComponent(id)}`, { method: 'DELETE' }).then(async (r) => {
      const data = (await r.json()) as { ok: boolean; error?: string }
      if (!r.ok || !data.ok) throw new Error(data.error ?? `DELETE source → ${r.status}`)
      return data
    }),
  clearKnowledge: () =>
    fetch('/api/knowledge/clear', { method: 'DELETE' }).then(async (r) => {
      const data = (await r.json()) as { ok: boolean; error?: string }
      if (!r.ok || !data.ok) throw new Error(data.error ?? `clear → ${r.status}`)
      return data
    }),
  importKnowledgeUrl: (url: string) =>
    jpost<{ ok: boolean; sourceId?: string; chunkCount?: number; message?: string; error?: string }>('/api/knowledge/import-url', { url }),
  searchProviders: () =>
    jget<{ ok: boolean; providers: Array<{ id: SearchProviderId; displayName: string; desc: string; baseUrl: string; keyPlaceholder: string }> }>('/api/search/providers'),
  verifySearchKey: (providerId: SearchProviderId, apiKey: string, baseUrl?: string, useStoredKey?: boolean) =>
    jpost<{ ok: boolean; providerId?: string; message?: string; error?: string }>(
      '/api/verify-search-key',
      useStoredKey && !apiKey ? { providerId, useStoredKey: true, ...(baseUrl ? { baseUrl } : {}) } : { providerId, apiKey, ...(baseUrl ? { baseUrl } : {}) },
    ),

  // ── Live Playground (M1) ──
  pgTasks: () => jget<PlaygroundTaskList>('/api/playground/tasks'),
  pgTask: (id: string) => jget<EvalTask>(`/api/playground/tasks/${encodeURIComponent(id)}`),
  pgSample: (id: string, kind: 'good' | 'bad') =>
    jget<{ taskId: string; kind: string; answer: string }>(`/api/playground/tasks/${encodeURIComponent(id)}/sample?kind=${kind}`),
  pgScore: (taskId: string, answer: string) =>
    jpost<ScoreResult>('/api/playground/score', { taskId, answer }),

  // ── Jev 判定器（M1：Playground 开关 + 判分旁路复核）──
  // 开关存在服务端设置里（playground_jev 行）；关闭时 /judge 一次都不出网。
  pgJevSettings: () => jget<{ ok: boolean; settings: JevSettingsView }>('/api/playground/jev'),
  pgSaveJevSettings: (patch: JevSettingsPatch) =>
    jpost<{ ok: boolean; settings: JevSettingsView }>('/api/playground/jev', patch),
  pgJevJudge: (taskId: string, answer: string, opts?: { batchId?: string | null; kind?: 'good' | 'bad' | null; clean?: boolean }) =>
    jpost<JevJudgeResult>(
      '/api/playground/jev/judge',
      {
        taskId,
        answer,
        ...(opts?.batchId ? { batchId: opts.batchId } : {}),
        ...(opts?.kind ? { kind: opts.kind } : {}),
        ...(opts?.clean ? { clean: true } : {}),
      },
    ),
  pgJevReviews: (q: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v != null && v !== '') qs.set(k, String(v))
    const tail = qs.toString()
    return jget<JevReviewRecord[]>(`/api/playground/jev/reviews${tail ? `?${tail}` : ''}`)
  },
  pgAssertionTasks: () =>
    jget<{ total: number; tasks: Array<{ id: string; dossierId: string; assertionId: string; goodAnswer: string; badAnswer: string; goldGood: string; goldBad: string }> }>(
      '/api/playground/assertions/tasks',
    ),
  pgAssertionJudge: (assertionId: string, kind: 'good' | 'bad', batchId?: string | null) =>
    jpost<JevReviewRecord>(
      '/api/playground/assertions/judge',
      { assertionId, kind, ...(batchId ? { batchId } : {}) },
    ),
  pgTagTasks: () =>
    jget<{ total: number; tasks: Array<{ id: string; scenarioId: string; branch: string; step: number; text: string }> }>(
      '/api/playground/tags/tasks',
    ),
  pgTagJudge: (tagId: string, kind: 'good' | 'bad', batchId?: string | null) =>
    jpost<JevReviewRecord>(
      '/api/playground/tags/judge',
      { tagId, kind, ...(batchId ? { batchId } : {}) },
    ),
  pgRagTasks: () =>
    jget<{
      total: number
      tasks: Array<{ id: string; queryId: string; query: string; goodAnswer: string; badAnswer: string; goldGood: string; goldBad: string }>
    }>('/api/playground/rag/tasks'),
  pgRagJudge: (ragId: string, kind: 'good' | 'bad', batchId?: string | null) =>
    jpost<JevReviewRecord>(
      '/api/playground/rag/judge',
      { ragId, kind, ...(batchId ? { batchId } : {}) },
    ),
  pgClearJevReviews: async (q: { batchId?: string; all?: boolean }) => {
    const qs = new URLSearchParams()
    if (q.batchId) qs.set('batchId', q.batchId)
    if (q.all) qs.set('all', 'true')
    const tail = qs.toString()
    const url = `/api/playground/jev/reviews${tail ? `?${tail}` : ''}`
    const r = await fetch(url, { method: 'DELETE' })
    if (!r.ok) {
      let detail = `${r.status}`
      try {
        detail = ((await r.json()) as { error?: string }).error ?? detail
      } catch { /* keep status */ }
      throw new Error(detail)
    }
    return r.json() as Promise<{ ok: boolean; deleted: number }>
  },

  // ── Live Playground (M2: live runs) ──
  pgPresets: () => jget<{ presets: PgPreset[]; evalSet: { total: number } }>('/api/playground/presets'),
  pgTargets: () => jget<RunTargets>('/api/playground/targets'),
  pgCreateRuns: (req: CreateRunsRequest) =>
    jpost<{ ok: boolean; created: Array<{ runId: string; taskId: string }>; error?: string }>('/api/playground/runs', req),
  pgRuns: (q: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(q)) if (v != null && v !== '') qs.set(k, v)
    const tail = qs.toString()
    return jget<RunSummary[]>(`/api/playground/runs${tail ? `?${tail}` : ''}`)
  },
  pgRun: (id: string) => jget<RunDetail>(`/api/playground/runs/${encodeURIComponent(id)}`),
  pgFork: (id: string, body: { config?: unknown; providerId?: string; model?: string } = {}) =>
    jpost<{ ok: boolean; created: { runId: string; taskId: string }; forkedFrom: string }>(
      `/api/playground/runs/${encodeURIComponent(id)}/fork`,
      body,
    ),
  pgDeleteRun: async (id: string) => {
    const r = await fetch(`/api/playground/runs/${encodeURIComponent(id)}`, { method: 'DELETE' })
    if (!r.ok) {
      let detail = `${r.status}`
      try {
        detail = ((await r.json()) as { error?: string }).error ?? detail
      } catch { /* keep status */ }
      throw new Error(detail)
    }
    return r.json() as Promise<{ ok: boolean; events: number; verdicts: number; assertions: number; killChain: number; blastRadius: number }>
  },
  pgMetrics: () => jget<LiveMetrics>('/api/playground/metrics'),
  pgRescore: (id: string, taskId: string) =>
    jpost<{ ok: boolean; run: RunDetail }>(
      `/api/playground/runs/${encodeURIComponent(id)}/rescore`,
      { taskId },
    ),
  pgImport: async (rawText: string) => {
    const r = await fetch('/api/playground/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rawText,
    })
    if (!r.ok) {
      let detail = `${r.status}`
      try {
        detail = ((await r.json()) as { error?: string }).error ?? detail
      } catch {
        /* keep status */
      }
      throw new Error(detail)
    }
    return (await r.json()) as { ok: boolean; imported: string[]; formats?: string[]; skipped?: number; error?: string }
  },
  pgExportUrl: (id: string, format: 'json' | 'jsonl' | 'txt' = 'json') =>
    `/api/playground/runs/${encodeURIComponent(id)}/export?format=${format}`,
  pgBulkExportUrl: (ids: string[], format: 'json' | 'jsonl' | 'txt') =>
    `/api/playground/export?ids=${ids.map(encodeURIComponent).join(',')}&format=${format}`,
  pgParseExport: (text: string) => JSON.parse(text) as PlaygroundRunFile | PlaygroundRunFile[],

  // ── M4 evolution (PRISM) ──
  pgEvoState: () => jget<{ ok: boolean } & EvoState>('/api/playground/evolve'),
  pgEvolve: (runIds?: string[]) =>
    jpost<{ ok: boolean } & EvoAnalysis & { state: EvoState; note?: string }>('/api/playground/evolve', { runIds }),
  pgApplyCard: async (cardId: string, body: { mode: 'manual' | 'auto'; autonomyLevel?: number }) => {
    // 422 carries the falsification result (falsified), so return the body
    // instead of throwing; the UI shows rescued/regressed either way.
    const r = await fetch(`/api/playground/cards/${encodeURIComponent(cardId)}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await r.json()) as ApplyResult & { ok: boolean; state: EvoState; error?: string }
  },
  pgRollback: (generationId: string) =>
    jpost<{ ok: boolean; state: EvoState; error?: string }>(
      `/api/playground/generations/${encodeURIComponent(generationId)}/rollback`,
      {},
    ),
  pgGateVerify: (commitId: string, opts?: { repeats?: number }) =>
    jpost<{ ok: boolean; state: EvoState; error?: string }>(
      `/api/playground/mutations/${encodeURIComponent(commitId)}/gate`,
      opts ?? {},
    ),
  pgRace: (body: { autonomyLevel: number; topN?: number; repeats?: number }) =>
    jpost<{ ok: boolean; state: EvoState; error?: string }>('/api/playground/evolve/race', body),
  pgAutoEvolve: (autonomyLevel: number) =>
    jpost<{ ok: boolean; state: EvoState; error?: string }>(
      '/api/playground/evolve/auto',
      { autonomyLevel },
    ),
}
