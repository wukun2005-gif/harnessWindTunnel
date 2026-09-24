/**
 * EPO OPS (espacenet) bibliographic search.
 * Ported from patentExaminator server/src/search/epo-ops.ts
 * (OAuth2 token cache 5-min, CQL builder, Atom/JSON response parsing;
 * logger 调用移除；源项目的 any casts 改为 Record<string, unknown> 收窄).
 */

import type { SearchResultItem } from '../../shared/search'

interface EpoToken {
  accessToken: string
  expiresAt: number
}

let cachedToken: EpoToken | null = null
let cachedCredentials: string | null = null // track which credentials the token belongs to

async function getEpoAccessToken(consumerKey: string, consumerSecret: string): Promise<string> {
  const now = Date.now()
  const credKey = `${consumerKey}:${consumerSecret}`
  if (cachedToken && cachedCredentials === credKey && cachedToken.expiresAt > now + 5 * 60 * 1000) {
    return cachedToken.accessToken
  }
  // Invalidate stale cache if credentials changed
  if (cachedCredentials && cachedCredentials !== credKey) {
    cachedToken = null
  }
  cachedCredentials = credKey

  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')
  const res = await fetch('https://ops.epo.org/3.2/auth/accesstoken', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(`[search] EPO OAuth2 token fetch failed: ${res.status} ${text.slice(0, 200)}`)
    throw new Error(`EPO OAuth2 认证失败 (HTTP ${res.status})。请检查 Consumer Key / Consumer Secret 是否正确。`)
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!data.access_token) {
    throw new Error('EPO OAuth2 响应缺少 access_token')
  }

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + (data.expires_in ?? 1200) * 1000,
  }

  return cachedToken.accessToken
}

/** Strip double quotes from a CQL search term — EPO OPS CQL does not support escaped quotes inside quoted values. */
function escapeCqlTerm(term: string): string {
  return term.replace(/"/g, ' ').replace(/\s+/g, ' ').trim()
}

function buildCqlQuery(searchTerms: string): string {
  const terms = searchTerms
    .split(/\s*\|\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  const conditions = terms.map((t) => {
    const escaped = escapeCqlTerm(t)
    if (/^[A-H][0-9][0-9][A-Z]/.test(t)) {
      return `ipc any "${escaped}"`
    }
    // EPO OPS CQL: 'all' = all words present in any order (not exact phrase).
    // This matches patents where all keywords appear in the same field.
    return `ti all "${escaped}" OR ab all "${escaped}" OR cl all "${escaped}"`
  })

  if (conditions.length === 0) {
    const escaped = escapeCqlTerm(searchTerms)
    return `ti all "${escaped}" OR ab all "${escaped}" OR cl all "${escaped}"`
  }

  return conditions.join(' AND ')
}

function parseAtomSingleField(field: unknown): string | undefined {
  if (!field) return undefined
  if (typeof field === 'string') return field
  if (Array.isArray(field)) return parseAtomSingleField(field[0])
  if (typeof field === 'object' && field !== null) {
    const obj = field as Record<string, unknown>
    if (typeof obj['$'] === 'string') return obj['$']
    if (typeof obj['content'] === 'string') return obj['content']
    if (Array.isArray(obj['content'])) return parseAtomSingleField(obj['content'])
  }
  return undefined
}

function parseEpoResponse(data: unknown): SearchResultItem[] {
  const results: SearchResultItem[] = []

  try {
    const root = data as Record<string, unknown>
    const worldData = root['ops:world-patent-data'] as Record<string, unknown> | undefined
    const biblioSearch = worldData?.['ops:biblio-search'] as Record<string, unknown> | undefined
    const searchResult = biblioSearch?.['ops:search-result'] as Record<string, unknown> | undefined
    if (!searchResult) return []

    // Response structure varies by Range:
    //   Range=1-1: exchange-documents → { exchange-document: {...} }
    //   Range=1-N: exchange-documents → [ { exchange-document: {...} }, ... ]
    const rawExchangeDocs = searchResult['exchange-documents'] ?? searchResult['ops:exchange-documents']
    if (!rawExchangeDocs) return []

    let docList: Record<string, unknown>[] = []
    if (Array.isArray(rawExchangeDocs)) {
      // Array of { exchange-document: {...} }
      for (const item of rawExchangeDocs) {
        const doc =
          (item as Record<string, unknown>)['exchange-document'] ?? (item as Record<string, unknown>)['ops:exchange-document']
        if (doc && typeof doc === 'object') docList.push(doc as Record<string, unknown>)
      }
    } else if (typeof rawExchangeDocs === 'object') {
      // Single object: { exchange-document: {...} }
      const doc =
        (rawExchangeDocs as Record<string, unknown>)['exchange-document'] ??
        (rawExchangeDocs as Record<string, unknown>)['ops:exchange-document']
      if (doc && typeof doc === 'object') {
        docList = Array.isArray(doc) ? (doc as Record<string, unknown>[]) : [doc as Record<string, unknown>]
      }
    }
    docList = docList.slice(0, 10)

    for (const d of docList) {
      if (typeof d !== 'object' || !d) continue

      // Publication identifiers are top-level attributes on exchange-document
      const pubCountry = typeof d['@country'] === 'string' ? d['@country'] : ''
      const pubNumber = typeof d['@doc-number'] === 'string' ? d['@doc-number'] : ''
      const pubKind = typeof d['@kind'] === 'string' ? d['@kind'] : ''
      const fullPubNumber = `${pubCountry}${pubNumber}${pubKind}`

      const biblio = d['bibliographic-data'] as Record<string, unknown> | undefined
      if (!biblio) continue

      // Title: invention-title can be array [{ $, @lang }] or single object
      const rawTitle = biblio['invention-title']
      let title: string | undefined
      if (Array.isArray(rawTitle)) {
        // Prefer English, then first available
        const enTitle = rawTitle.find((t) => (t as Record<string, unknown>)?.['@lang'] === 'en')
        title = ((enTitle ?? rawTitle[0]) as Record<string, unknown> | undefined)?.['$'] as string | undefined
      } else {
        title = parseAtomSingleField(rawTitle)
      }

      const abstract = parseAtomSingleField(biblio['abstract'])

      // IPC codes: classifications-ipcr → classification-ipcr → text.$
      const ipcRaw = biblio['classifications-ipcr'] as Record<string, unknown> | undefined
      const ipcList = ipcRaw?.['classification-ipcr']
      const ipcClasses: string[] = []
      if (Array.isArray(ipcList)) {
        for (const item of ipcList) {
          const text = (item as Record<string, unknown>)?.['text'] as Record<string, unknown> | undefined
          if (typeof text?.['$'] === 'string') ipcClasses.push(text['$'])
        }
      } else if (ipcList) {
        const text = (ipcList as Record<string, unknown>)?.['text'] as Record<string, unknown> | undefined
        if (typeof text?.['$'] === 'string') ipcClasses.push(text['$'])
      }

      // Date from publication-reference → document-id[0].date.$
      const pubRef = biblio['publication-reference'] as Record<string, unknown> | undefined
      const docIds = pubRef?.['document-id']
      let pubDate = ''
      if (Array.isArray(docIds)) {
        const docdb = docIds.find((id) => (id as Record<string, unknown>)?.['@document-id-type'] === 'docdb')
        pubDate = ((docdb as Record<string, unknown> | undefined)?.['date'] as Record<string, unknown>)?.['$'] as string ?? ''
      } else if (docIds) {
        pubDate = ((docIds as Record<string, unknown>)?.['date'] as Record<string, unknown>)?.['$'] as string ?? ''
      }

      const displayTitle = title || `${fullPubNumber || 'Unknown'} - 专利文献`

      const contentParts: string[] = []
      if (abstract) contentParts.push(`摘要: ${abstract}`)
      if (ipcClasses.length > 0) contentParts.push(`IPC: ${ipcClasses.join(', ')}`)
      if (pubDate) contentParts.push(`公开日: ${pubDate}`)

      results.push({
        title: displayTitle,
        url: fullPubNumber
          ? `https://worldwide.espacenet.com/publicationDetails/biblio?CC=${pubCountry}&NR=${pubNumber}&KC=${pubKind}`
          : 'https://ops.epo.org/',
        content: contentParts.join('; ') || displayTitle,
        score: 0,
      })
    }
  } catch (err) {
    console.error(`[search] Failed to parse EPO response: ${String(err)}`)
  }

  return results
}

export async function searchEpo(
  searchTerms: string,
  maxResults: number,
  consumerKey: string,
  consumerSecret: string,
): Promise<SearchResultItem[]> {
  const accessToken = await getEpoAccessToken(consumerKey, consumerSecret)
  const cql = buildCqlQuery(searchTerms)

  const url = new URL('https://ops.epo.org/3.2/rest-services/published-data/search/biblio')
  url.searchParams.set('q', cql)
  url.searchParams.set('Range', `1-${Math.min(maxResults, 25)}`)

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(30_000),
  })

  if (res.status === 429) {
    const retryAfter = res.headers.get('Retry-After')
    const waitSec = retryAfter ? parseInt(retryAfter, 10) : 10
    console.error(`[search] EPO OPS rate limited, retry after ${waitSec}s`)
    throw new Error(`EPO OPS 请求频率超限，请等待 ${waitSec} 秒后重试。`)
  }

  if (res.status === 404 || (res.ok && res.headers.get('content-type')?.includes('xml'))) {
    const text = await res.text().catch(() => '')
    if (text.includes('<fault') || text.includes('no results') || text.includes('SEARCH')) {
      return []
    }
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    console.error(`[search] EPO OPS API error: ${res.status} ${text.slice(0, 300)}`)
    throw new Error(`EPO OPS API 请求失败 (HTTP ${res.status})`)
  }

  const data = await res.json()
  return parseEpoResponse(data)
}
