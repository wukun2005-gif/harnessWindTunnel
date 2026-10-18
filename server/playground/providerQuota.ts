import { hostOf } from './jevLog'

/**
 * OpenRouter's free tier is a shared 20 requests/minute, 1000/day quota, and this
 * project draws on it from two callers at once: the answer model (`llmClient`)
 * and the judge (`jevClient`). That is why the ceiling lives here instead of in
 * either caller.
 *
 * A fixed "N calls in flight" cap only respects the quota at one assumed latency.
 * 8 in flight ≈ 19 requests/minute at the ~25s average call this project
 * measured — but the demo's legal tasks take 35–90s, and there 8 in flight
 * spends barely 10 of the 20 allowed requests a minute while the wall clock pays
 * for the idle quota. So the quota is enforced as an actual rate limit over a
 * rolling 60s window and callers may keep more runs in flight: a burst of fast
 * calls gets paced (a short wait) instead of rejected (a 429 plus a retry).
 *
 * Only openrouter targets are paced — other providers have their own quota.
 * `HWT_LLM_RPM=0` disables the pacing (offline tests, a paid key).
 */
const WINDOW_MS = 60_000

/** Requests per rolling minute. 18 of the published 20 leaves room for retries. */
const RPM = Number(process.env['HWT_LLM_RPM'] ?? 18)

const recentStarts: number[] = []

/** Wait until one more request fits inside the rolling window, then book it. */
export async function awaitProviderQuota(baseUrl: string): Promise<void> {
  if (!(RPM > 0)) return
  if (!hostOf(baseUrl).includes('openrouter')) return
  for (;;) {
    const now = Date.now()
    while (recentStarts.length > 0 && now - recentStarts[0]! >= WINDOW_MS) recentStarts.shift()
    if (recentStarts.length < RPM) {
      recentStarts.push(now)
      return
    }
    // The oldest start leaves the window in this many ms. Every waiter re-checks
    // after waking, so an oversleeping timer can never let two calls share a slot.
    const waitMs = Math.max(25, WINDOW_MS - (now - recentStarts[0]!) + 20)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }
}

/** Test/observability helper: how many starts the current window holds. */
export function quotaWindowStarts(): number {
  const now = Date.now()
  while (recentStarts.length > 0 && now - recentStarts[0]! >= WINDOW_MS) recentStarts.shift()
  return recentStarts.length
}
