/**
 * SSRF protection — reject URLs that point to private/internal networks.
 * Verbatim port of patentExaminator server/src/lib/urlValidation.ts.
 */

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
])

// RFC 1918 + link-local + cloud metadata
const BLOCKED_PREFIXES = [
  '10.',
  '192.168.',
  '172.16.', '172.17.', '172.18.', '172.19.',
  '172.20.', '172.21.', '172.22.', '172.23.',
  '172.24.', '172.25.', '172.26.', '172.27.',
  '172.28.', '172.29.', '172.30.', '172.31.',
  '169.254.',
  '0.',
  '127.',
]

const AWS_METADATA_HOST = '169.254.169.254'

export class BlockedUrlError extends Error {
  constructor(url: string, reason: string) {
    super(`URL blocked (${reason}): ${url}`)
    this.name = 'BlockedUrlError'
  }
}

/**
 * Validate that a URL does not point to a private/internal network.
 * Throws BlockedUrlError if the URL is blocked.
 */
export function validateExternalUrl(urlString: string): void {
  let url: URL
  try {
    url = new URL(urlString)
  } catch {
    throw new BlockedUrlError(urlString, 'invalid URL format')
  }

  // Only allow http/https
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BlockedUrlError(urlString, `unsupported protocol: ${url.protocol}`)
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets

  // Check blocked hostnames
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new BlockedUrlError(urlString, `blocked hostname: ${hostname}`)
  }

  // Check blocked IP prefixes
  for (const prefix of BLOCKED_PREFIXES) {
    if (hostname.startsWith(prefix)) {
      throw new BlockedUrlError(urlString, `private/internal IP: ${hostname}`)
    }
  }

  // AWS metadata endpoint (covers both IP and hostname variants)
  if (hostname === AWS_METADATA_HOST) {
    throw new BlockedUrlError(urlString, 'cloud metadata endpoint')
  }
}

/**
 * Validate a record of providerId → baseUrl mappings.
 * Throws on the first blocked URL.
 */
export function validateProviderBaseUrls(baseUrls: Record<string, string> | undefined): void {
  if (!baseUrls) return
  for (const [, url] of Object.entries(baseUrls)) {
    if (url) {
      validateExternalUrl(url)
    }
  }
}
