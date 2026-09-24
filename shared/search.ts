// Search API types + provider presets.
// Ported from patentExaminator shared/src/types/agents.ts (PRESET_SEARCH_PROVIDERS)
// and shared/src/types/api.ts (SearchReferences* shapes) so `#/settings` can
// configure Tavily / SerpAPI / EPO OPS / Serper keys and run the same
// "claimText + features → candidate prior-art documents" search the examiner
// app runs.

export type SearchProviderId = 'tavily' | 'serpapi' | 'epo' | 'serper' | 'custom'

export interface PresetSearchProvider {
  id: SearchProviderId
  displayName: string
  desc: string
  baseUrl: string
  keyPlaceholder: string
}

export const PRESET_SEARCH_PROVIDERS: PresetSearchProvider[] = [
  { id: 'tavily', displayName: 'Tavily', desc: '免费额度 1000 次/月，注册地址: app.tavily.com', baseUrl: 'https://api.tavily.com', keyPlaceholder: 'tvly-...' },
  { id: 'serpapi', displayName: 'SerpAPI', desc: 'Google 专利搜索 API，免费额度 100 次/月', baseUrl: 'https://serpapi.com', keyPlaceholder: 'your-serpapi-key' },
  { id: 'epo', displayName: 'EPO OPS', desc: '欧洲专利局官方 API (OPS v3.2)，结构化专利数据', baseUrl: 'https://ops.epo.org/3.2', keyPlaceholder: 'Consumer Key / Consumer Secret' },
  { id: 'serper', displayName: 'Serper.dev', desc: 'Google 搜索 API，免费额度 2500 次，注册地址: serper.dev', baseUrl: 'https://google.serper.dev', keyPlaceholder: 'your-serper-key' },
]

export interface SearchProviderConnection {
  providerId: SearchProviderId
  name: string
  /** 服务端保存的 key（EPO 为 "consumerKey:consumerSecret"）；下发前端时被替换为 '' + hasKey 标记 */
  apiKeyRef: string
  enabled: boolean
  baseUrl?: string
}

/** 单条搜索结果（webSearch.ts 的返回形态） */
export interface SearchResultItem {
  title: string
  url: string
  content: string
  score: number
}

export interface SearchReferencesRequest {
  caseId?: string
  claimText: string
  features: Array<{ featureCode: string; description: string }>
  maxResults?: number
  /** 覆盖设置里选中的搜索服务商（不传则用设置里启用的那一个） */
  searchProviderId?: SearchProviderId
  /** 覆盖设置里保存的 key（测试用；正常路径由服务端从设置库读取） */
  searchApiKey?: string
  searchBaseUrl?: string
  /** 覆盖 LLM（检索式提取用）；不传则用 provider_all 里启用的第一家 */
  providerId?: string
  modelId?: string
}

export interface SearchReferencesCandidate {
  title: string
  publicationNumber: string
  publicationDate?: string
  summary: string
  relevanceScore: number
  recommendationReason: string
  sourceUrl?: string
}

export interface SearchSummary {
  featureCount: number
  queryCount: number
  dataSource: string
  queries: string[]
}

export interface SearchReferencesResponse {
  ok: boolean
  candidates: SearchReferencesCandidate[]
  searchQuery?: string
  searchSummary?: SearchSummary
  error?: string
}

export interface VerifySearchKeyResponse {
  ok: boolean
  providerId?: string
  message?: string
  error?: string
}

/** 设置屏「知识库/检索」区读到的设置（key 已脱敏） */
export interface RetrievalSettingsView {
  knowledge: import('./knowledge').KnowledgeConfig
  knowledgeProviders: Array<import('./knowledge').KnowledgeProviderConnection & { hasKey: boolean }>
  searchProviders: Array<SearchProviderConnection & { hasKey: boolean }>
}
