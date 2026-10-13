// Retrieval settings store — the settings-screen infrastructure copied from
// patentExaminator (knowledge base config, remote embedding API, remote
// re-ranker API, Search API providers) is persisted in this project's
// production settings store (server-data/settings.json, the same atomic JSON
// store the LLM provider settings use). Keys mirror patentExaminator's
// AppSettings shape: { knowledge, knowledgeProviders, searchProviders } stored
// under the single row `retrieval_all`.
//
// B-041 credential rule: raw keys never leave the server. The UI gets a masked
// view (`hasKey` flags only) and writes are key-merge patches (`apiKey: ''`
// keeps the stored key, `clearKey: true` removes it).
import { getSetting, putSetting } from '../settingsStore'
import {
  DEFAULT_KNOWLEDGE_CONFIG,
  PRESET_KNOWLEDGE_PROVIDERS,
  type KnowledgeConfig,
  type KnowledgeProviderConnection,
  type KnowledgeProviderType,
} from '../../shared/knowledge'
export interface RerankProviderConfig {
  providerId: string
  baseUrl: string
  apiKey: string
  modelId: string
}
import {
  PRESET_SEARCH_PROVIDERS,
  type RetrievalSettingsView,
  type SearchProviderConnection,
  type SearchProviderId,
} from '../../shared/search'

export interface EmbedderConfig {
  providerId: string
  baseUrl: string
  apiKey: string
  modelId: string
}

const SETTINGS_KEY = 'retrieval_all'

export interface RetrievalSettings {
  knowledge: KnowledgeConfig
  knowledgeProviders: KnowledgeProviderConnection[]
  searchProviders: SearchProviderConnection[]
}

export interface KnowledgeProviderPatch {
  providerType: KnowledgeProviderType
  providerId: string
  displayName?: string
  baseUrl?: string
  modelId?: string
  availableModels?: string[]
  enabled?: boolean
  /** New key to store. Empty/absent keeps the stored key untouched. */
  apiKey?: string
  /** Explicitly drop the stored key. */
  clearKey?: boolean
}

export interface SearchProviderPatch {
  providerId: SearchProviderId
  name?: string
  baseUrl?: string
  enabled?: boolean
  apiKey?: string
  clearKey?: boolean
}

export interface RetrievalSettingsPatch {
  knowledge?: Partial<KnowledgeConfig>
  knowledgeProviders?: KnowledgeProviderPatch[]
  searchProviders?: SearchProviderPatch[]
}

function presetKnowledge(providerType: KnowledgeProviderType, providerId: string) {
  return PRESET_KNOWLEDGE_PROVIDERS.find((p) => p.providerType === providerType && p.providerId === providerId)
}

function normalizeKnowledgeConfig(raw: unknown): KnowledgeConfig {
  const value = (raw ?? {}) as Partial<KnowledgeConfig>
  return {
    enabled: value.enabled ?? DEFAULT_KNOWLEDGE_CONFIG.enabled,
    topK: typeof value.topK === 'number' ? value.topK : DEFAULT_KNOWLEDGE_CONFIG.topK,
    scoreThreshold: typeof value.scoreThreshold === 'number' ? value.scoreThreshold : DEFAULT_KNOWLEDGE_CONFIG.scoreThreshold,
  }
}

/** Stored state, filled out with the preset cards so the UI always shows every slot. */
export function getRetrievalSettings(): RetrievalSettings {
  const raw = (getSetting(SETTINGS_KEY) ?? {}) as Partial<RetrievalSettings>
  const storedProviders = Array.isArray(raw.knowledgeProviders) ? raw.knowledgeProviders : []
  const storedSearch = Array.isArray(raw.searchProviders) ? raw.searchProviders : []

  const knowledgeProviders: KnowledgeProviderConnection[] = PRESET_KNOWLEDGE_PROVIDERS.map((preset) => {
    const stored = storedProviders.find(
      (p) => p.providerType === preset.providerType && p.providerId === preset.providerId,
    )
    return {
      providerType: preset.providerType,
      providerId: preset.providerId,
      displayName: stored?.displayName ?? preset.displayName,
      baseUrl: stored?.baseUrl ?? preset.baseUrl,
      apiKeyRef: stored?.apiKeyRef ?? '',
      modelId: stored?.modelId ?? preset.defaultModelId,
      availableModels: stored?.availableModels ?? [],
      enabled: stored?.enabled ?? false,
    }
  })
  // Keep connections for providers that are not preset cards (imported settings).
  for (const stored of storedProviders) {
    if (!presetKnowledge(stored.providerType, stored.providerId)) knowledgeProviders.push(stored)
  }

  const searchProviders: SearchProviderConnection[] = PRESET_SEARCH_PROVIDERS.map((preset) => {
    const stored = storedSearch.find((p) => p.providerId === preset.id)
    const baseUrl = stored?.baseUrl ?? preset.baseUrl
    return {
      providerId: preset.id,
      name: stored?.name ?? preset.displayName,
      apiKeyRef: stored?.apiKeyRef ?? '',
      enabled: stored?.enabled ?? false,
      ...(baseUrl ? { baseUrl } : {}),
    }
  })
  for (const stored of storedSearch) {
    if (!PRESET_SEARCH_PROVIDERS.some((p) => p.id === stored.providerId)) searchProviders.push(stored)
  }

  return { knowledge: normalizeKnowledgeConfig(raw.knowledge), knowledgeProviders, searchProviders }
}

/** Upsert with key-merge semantics: absent/empty apiKey keeps the stored key. */
export function putRetrievalSettings(patch: RetrievalSettingsPatch): RetrievalSettings {
  const current = getRetrievalSettings()

  if (patch.knowledge) {
    current.knowledge = normalizeKnowledgeConfig({ ...current.knowledge, ...patch.knowledge })
  }

  for (const incoming of patch.knowledgeProviders ?? []) {
    const index = current.knowledgeProviders.findIndex(
      (p) => p.providerType === incoming.providerType && p.providerId === incoming.providerId,
    )
    const existing = index >= 0 ? current.knowledgeProviders[index] : undefined
    const preset = presetKnowledge(incoming.providerType, incoming.providerId)
    const next: KnowledgeProviderConnection = {
      providerType: incoming.providerType,
      providerId: incoming.providerId,
      displayName: incoming.displayName ?? existing?.displayName ?? preset?.displayName ?? incoming.providerId,
      baseUrl: incoming.baseUrl ?? existing?.baseUrl ?? preset?.baseUrl ?? '',
      apiKeyRef: incoming.clearKey
        ? ''
        : (incoming.apiKey?.trim() ? incoming.apiKey.trim() : (existing?.apiKeyRef ?? '')),
      modelId: incoming.modelId ?? existing?.modelId ?? preset?.defaultModelId ?? '',
      availableModels: incoming.availableModels ?? existing?.availableModels ?? [],
      enabled: incoming.enabled ?? existing?.enabled ?? false,
    }
    if (index >= 0) current.knowledgeProviders[index] = next
    else current.knowledgeProviders.push(next)
  }

  for (const incoming of patch.searchProviders ?? []) {
    const index = current.searchProviders.findIndex((p) => p.providerId === incoming.providerId)
    const existing = index >= 0 ? current.searchProviders[index] : undefined
    const preset = PRESET_SEARCH_PROVIDERS.find((p) => p.id === incoming.providerId)
    const next: SearchProviderConnection = {
      providerId: incoming.providerId,
      name: incoming.name ?? existing?.name ?? preset?.displayName ?? incoming.providerId,
      apiKeyRef: incoming.clearKey
        ? ''
        : (incoming.apiKey?.trim() ? incoming.apiKey.trim() : (existing?.apiKeyRef ?? '')),
      enabled: incoming.enabled ?? existing?.enabled ?? false,
      ...(incoming.baseUrl ?? existing?.baseUrl ? { baseUrl: incoming.baseUrl ?? existing?.baseUrl } : {}),
    }
    if (index >= 0) current.searchProviders[index] = next
    else current.searchProviders.push(next)
  }

  putSetting(SETTINGS_KEY, current)
  return current
}

/** UI-facing view: keys are stripped, `hasKey` flags replace them (B-041). */
export function retrievalSettingsView(): RetrievalSettingsView {
  const settings = getRetrievalSettings()
  return {
    knowledge: settings.knowledge,
    knowledgeProviders: settings.knowledgeProviders.map((p) => ({
      ...p,
      apiKeyRef: '',
      hasKey: p.apiKeyRef.length > 0,
    })),
    searchProviders: settings.searchProviders.map((p) => ({
      ...p,
      apiKeyRef: '',
      hasKey: p.apiKeyRef.length > 0,
    })),
  }
}

/** Enabled embedding provider → embedder config, or null when not configured. */
export function embedderConfig(): EmbedderConfig | null {
  const provider = getRetrievalSettings().knowledgeProviders.find(
    (p) => p.providerType === 'embedding' && p.enabled && p.apiKeyRef.length > 0 && p.baseUrl.length > 0 && p.modelId.length > 0,
  )
  if (!provider) return null
  return { providerId: provider.providerId, baseUrl: provider.baseUrl, apiKey: provider.apiKeyRef, modelId: provider.modelId }
}

/** Enabled re-ranker provider → rerank config, or null when not configured. */
export function rerankProviderConfig(): RerankProviderConfig | null {
  const provider = getRetrievalSettings().knowledgeProviders.find(
    (p) => p.providerType === 'reranker' && p.enabled && p.apiKeyRef.length > 0 && p.baseUrl.length > 0 && p.modelId.length > 0,
  )
  if (!provider) return null
  return { providerId: provider.providerId, baseUrl: provider.baseUrl, apiKey: provider.apiKeyRef, modelId: provider.modelId }
}

/** First enabled search provider with a key (single data source, like the source app). */
export function activeSearchProvider(): { providerId: SearchProviderId; apiKey: string; baseUrl?: string } | null {
  const provider = getRetrievalSettings().searchProviders.find((p) => p.enabled && p.apiKeyRef.length > 0)
  if (!provider) return null
  return {
    providerId: provider.providerId,
    apiKey: provider.apiKeyRef,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  }
}

/**
 * A SPECIFIC search provider, by id — for callers that must pin one provider
 * rather than take "whichever is first enabled". Returns null when that provider
 * is missing or has no key; callers must NOT fall back to another provider,
 * because switching providers mid-experiment would change the harness.
 */
export function searchProviderById(providerId: SearchProviderId): { providerId: SearchProviderId; apiKey: string; baseUrl?: string } | null {
  const provider = getRetrievalSettings().searchProviders.find(
    (p) => p.providerId === providerId && p.enabled && p.apiKeyRef.length > 0,
  )
  if (!provider) return null
  return {
    providerId: provider.providerId,
    apiKey: provider.apiKeyRef,
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
  }
}

/** Search provider row including its stored key (server-internal use). */
export function searchProviderRow(providerId: SearchProviderId): SearchProviderConnection | undefined {
  return getRetrievalSettings().searchProviders.find((p) => p.providerId === providerId)
}
