/**
 * 联网检索服务 — 多查询并行、URL 去重合并
 * Ported from patentExaminator server/src/services/webSearch.ts
 * (tavily / serper / serpapi / EPO OPS / custom adapter; 服务端日志保留 info/warn/error 三级).
 */

import { searchEpo } from './epo-ops'
import type { SearchResultItem, SearchProviderId } from '../../shared/search'

const FETCH_TIMEOUT_MS = 30_000 // 30s timeout for search provider requests

export interface WebSearchResponse {
  results: SearchResultItem[]
  query: string
}

export interface WebSearchProviderConfig {
  providerId: SearchProviderId
  apiKey: string
  baseUrl?: string
}

/**
 * Search for patent-related文献 using configured search API.
 * All results come from real search — no hallucination.
 * Supports multiple queries — runs them in parallel and merges results.
 */
export async function searchPatents(
  queries: string | string[],
  maxResults = 10,
  config?: Partial<WebSearchProviderConfig> & { apiKey?: string },
): Promise<WebSearchResponse> {
  const apiKey = config?.apiKey
  if (!apiKey) {
    throw new Error('No search API key configured (must be passed via config, not from environment)')
  }

  const queryList = Array.isArray(queries) ? queries : [queries]
  const providerId = config?.providerId || 'tavily'
  const baseUrl = config?.baseUrl
  console.info(`[search] searchPatents provider=${providerId} hasKey=${!!apiKey} queries=${queryList.length}`)

  // Run all queries in parallel (tolerate individual query failures)
  const perQuery = Math.max(3, Math.ceil(maxResults / queryList.length))
  const allResults = await Promise.all(
    queryList.map((q) => {
      const searchFn =
        providerId === 'tavily'
          ? searchTavily
          : providerId === 'epo'
            ? searchEpoAdapter
            : providerId === 'serper'
              ? (k: string, n: number, a: string) => searchSerper(k, n, a, baseUrl)
              : providerId === 'serpapi'
                ? searchSerpapi
                : baseUrl
                  ? (k: string, n: number, a: string) => searchCustom(k, n, a, baseUrl)
                  : null
      if (!searchFn) return Promise.resolve([] as SearchResultItem[])
      return searchFn(q, perQuery, apiKey as string).catch((err) => {
        console.warn(`[search] query failed, skipping: ${String(err).slice(0, 200)}`)
        return [] as SearchResultItem[]
      })
    }),
  )

  // Merge and deduplicate by URL
  const seen = new Set<string>()
  const merged: SearchResultItem[] = []
  for (const results of allResults) {
    for (const r of results) {
      const key = r.url.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(r)
      }
    }
  }

  return { results: merged.slice(0, maxResults * 2), query: queryList.join(' | ') }
}

async function searchTavily(query: string, maxResults: number, apiKey: string): Promise<SearchResultItem[]> {
  // Two-pass strategy: patent-domain search + open web search
  // No extra noise words appended — the query from LLM should be clean and focused
  const patentResults = await tavilySearch(query, Math.ceil(maxResults / 2), apiKey, {
    include_domains: ['patents.google.com', 'patentscope.wipo.int'],
  })

  const generalResults = await tavilySearch(query, maxResults, apiKey, {})

  // Merge and deduplicate
  const seen = new Set<string>()
  const merged: SearchResultItem[] = []
  for (const r of [...patentResults, ...generalResults]) {
    const key = r.url.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(r)
    }
  }

  return merged
}

async function tavilySearch(
  query: string,
  maxResults: number,
  apiKey: string,
  options: { include_domains?: string[] },
): Promise<SearchResultItem[]> {
  const body: Record<string, unknown> = {
    api_key: apiKey,
    query,
    max_results: maxResults,
    include_answer: false,
    include_raw_content: false,
    search_depth: 'advanced',
  }
  if (options.include_domains && options.include_domains.length > 0) {
    body['include_domains'] = options.include_domains
  }

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error(`[search] Tavily API error: ${response.status} ${text.slice(0, 200)}`)
    throw new Error(`Tavily API error: ${response.status}`)
  }

  const data = (await response.json()) as {
    results?: Array<{ title: string; url: string; content: string; score: number }>
  }

  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score,
  }))
}

async function searchSerper(query: string, maxResults: number, apiKey: string, baseUrl?: string): Promise<SearchResultItem[]> {
  const endpoint = (baseUrl || 'https://google.serper.dev') + '/search'
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': apiKey,
    },
    body: JSON.stringify({ q: query, num: maxResults }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error(`[search] Serper API error: ${response.status} ${text.slice(0, 200)}`)
    throw new Error(`Serper API error: ${response.status}`)
  }

  const data = (await response.json()) as {
    organic?: Array<{ title: string; link: string; snippet: string; position?: number }>
  }

  return (data.organic ?? []).map((r) => ({
    title: r.title,
    url: r.link,
    content: r.snippet,
    score: r.position ? 1 / r.position : 0,
  }))
}

async function searchSerpapi(query: string, maxResults: number, apiKey: string): Promise<SearchResultItem[]> {
  const url = new URL('https://serpapi.com/search')
  url.searchParams.set('q', query)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('engine', 'google')
  url.searchParams.set('num', String(maxResults))

  const response = await fetch(url.toString(), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error(`[search] SerpAPI error: ${response.status} ${text.slice(0, 200)}`)
    throw new Error(`SerpAPI error: ${response.status}`)
  }

  const data = (await response.json()) as {
    organic_results?: Array<{ title: string; link: string; snippet: string; position?: number }>
  }

  return (data.organic_results ?? []).map((r) => ({
    title: r.title,
    url: r.link,
    content: r.snippet,
    score: r.position ? 1 / r.position : 0,
  }))
}

async function searchCustom(query: string, maxResults: number, apiKey: string, baseUrl: string): Promise<SearchResultItem[]> {
  const url = new URL(baseUrl)
  url.searchParams.set('q', query)
  url.searchParams.set('max_results', String(maxResults))

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    console.error(`[search] Custom search API error: ${response.status} ${text.slice(0, 200)}`)
    throw new Error(`Search API error: ${response.status}`)
  }

  const data = (await response.json()) as {
    results?: Array<{ title: string; url: string; content: string; score?: number }>
  }

  return (data.results ?? []).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    score: r.score ?? 0,
  }))
}

/**
 * EPO OPS adapter — apiKey is "consumerKey:consumerSecret" colon-delimited.
 */
async function searchEpoAdapter(query: string, maxResults: number, apiKey: string): Promise<SearchResultItem[]> {
  const colonIdx = apiKey.indexOf(':')
  if (colonIdx === -1) {
    throw new Error('EPO OPS 需要 Consumer Key 和 Consumer Secret，格式为 key:secret')
  }
  const consumerKey = apiKey.slice(0, colonIdx)
  const consumerSecret = apiKey.slice(colonIdx + 1)
  return searchEpo(query, maxResults, consumerKey, consumerSecret)
}
