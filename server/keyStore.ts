// F4-6 in-memory secret vault. Raw apiKeys live here ONLY: never written to
// disk, never logged, never returned by any endpoint. Restart wipes them by
// design (connections re-register their keys on next save).
const vault = new Map<string, string>()

export function keyRefFor(providerId: string): string {
  return `key_${providerId}`
}

/** Store a key under its provider ref. Empty keys remove the entry. */
export function setKey(providerId: string, apiKey: string): string {
  const ref = keyRefFor(providerId)
  if (apiKey) vault.set(ref, apiKey)
  else vault.delete(ref)
  return ref
}

export function hasKey(providerId: string): boolean {
  return vault.has(keyRefFor(providerId))
}

/** Internal use only (live model calls). No endpoint exposes this. */
export function getKey(providerId: string): string | null {
  return vault.get(keyRefFor(providerId)) ?? null
}

export function keyCount(): number {
  return vault.size
}
