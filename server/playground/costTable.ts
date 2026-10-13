// Provider × model unit-price table (design §11.2 / §14 L3).
//
// Decision (closes §11.2 undecided): built-in static USD/MTok table keyed by
// providerId + model id, with provider-level fallbacks. Cost is always
// computed at read time (token × rate) and never persisted. Unknown models
// return null — never invent a price (§11.2 "价表落地前 cost 字段留空，不造数").
//
// Rates are approximate public list prices (USD per 1M tokens). Update when
// providers change pricing; overrides via env are not required for v0.

export interface TokenRate {
  /** USD per 1M input tokens. */
  inputPerMTok: number
  /** USD per 1M output tokens. */
  outputPerMTok: number
}

/**
 * When only a total token count is available (pg_runs.tokens), blend as
 * 70% input / 30% output — typical agent-with-tools mix (long context in,
 * shorter answers out). Prefer prompt/completion split when present.
 */
export const BLEND_INPUT_SHARE = 0.7

/** Provider-level default when the specific model is unknown. */
const PROVIDER_DEFAULTS: Record<string, TokenRate> = {
  deepseek: { inputPerMTok: 0.28, outputPerMTok: 0.42 },
  qwen: { inputPerMTok: 0.3, outputPerMTok: 0.9 },
  bailian: { inputPerMTok: 0.3, outputPerMTok: 0.9 },
  kimi: { inputPerMTok: 1.2, outputPerMTok: 1.2 },
  glm: { inputPerMTok: 0.5, outputPerMTok: 2.0 },
  minimax: { inputPerMTok: 0.3, outputPerMTok: 1.2 },
  gemini: { inputPerMTok: 0.35, outputPerMTok: 1.05 },
  openrouter: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  opencode: { inputPerMTok: 0.5, outputPerMTok: 1.5 },
  volcengine: { inputPerMTok: 0.4, outputPerMTok: 1.2 },
  mimo: { inputPerMTok: 0.3, outputPerMTok: 0.9 },
  bedrock: { inputPerMTok: 3.0, outputPerMTok: 15.0 },
}

/** Exact / prefix model overrides (matched longest-prefix first within provider). */
const MODEL_RATES: Array<{ providerId: string; model: string; rate: TokenRate }> = [
  { providerId: 'deepseek', model: 'deepseek-chat', rate: { inputPerMTok: 0.27, outputPerMTok: 1.1 } },
  { providerId: 'deepseek', model: 'deepseek-reasoner', rate: { inputPerMTok: 0.55, outputPerMTok: 2.19 } },
  { providerId: 'qwen', model: 'qwen-plus', rate: { inputPerMTok: 0.4, outputPerMTok: 1.2 } },
  { providerId: 'qwen', model: 'qwen-turbo', rate: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { providerId: 'qwen', model: 'qwen-max', rate: { inputPerMTok: 2.4, outputPerMTok: 9.6 } },
  { providerId: 'qwen', model: 'qwen3', rate: { inputPerMTok: 0.3, outputPerMTok: 0.9 } },
  { providerId: 'bailian', model: 'qwen', rate: { inputPerMTok: 0.3, outputPerMTok: 0.9 } },
  { providerId: 'kimi', model: 'moonshot', rate: { inputPerMTok: 1.2, outputPerMTok: 1.2 } },
  { providerId: 'kimi', model: 'kimi', rate: { inputPerMTok: 1.2, outputPerMTok: 1.2 } },
  { providerId: 'glm', model: 'glm-4', rate: { inputPerMTok: 0.5, outputPerMTok: 2.0 } },
  { providerId: 'glm', model: 'glm-4.5', rate: { inputPerMTok: 0.6, outputPerMTok: 2.2 } },
  { providerId: 'gemini', model: 'gemini-2.5-pro', rate: { inputPerMTok: 1.25, outputPerMTok: 10.0 } },
  { providerId: 'gemini', model: 'gemini-2.5-flash', rate: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { providerId: 'gemini', model: 'gemini-2.0-flash', rate: { inputPerMTok: 0.1, outputPerMTok: 0.4 } },
  { providerId: 'gemini', model: 'gemini-1.5-pro', rate: { inputPerMTok: 1.25, outputPerMTok: 5.0 } },
  { providerId: 'gemini', model: 'gemini-1.5-flash', rate: { inputPerMTok: 0.075, outputPerMTok: 0.3 } },
  { providerId: 'openrouter', model: 'openai/gpt-4o', rate: { inputPerMTok: 2.5, outputPerMTok: 10.0 } },
  { providerId: 'openrouter', model: 'openai/gpt-4o-mini', rate: { inputPerMTok: 0.15, outputPerMTok: 0.6 } },
  { providerId: 'openrouter', model: 'anthropic/claude-sonnet', rate: { inputPerMTok: 3.0, outputPerMTok: 15.0 } },
  { providerId: 'openrouter', model: 'anthropic/claude-3.5-sonnet', rate: { inputPerMTok: 3.0, outputPerMTok: 15.0 } },
  { providerId: 'openrouter', model: 'google/gemini', rate: { inputPerMTok: 0.35, outputPerMTok: 1.05 } },
  { providerId: 'openrouter', model: 'deepseek/', rate: { inputPerMTok: 0.28, outputPerMTok: 0.42 } },
  { providerId: 'volcengine', model: 'doubao', rate: { inputPerMTok: 0.4, outputPerMTok: 1.2 } },
  { providerId: 'bedrock', model: 'anthropic.claude', rate: { inputPerMTok: 3.0, outputPerMTok: 15.0 } },
  { providerId: 'bedrock', model: 'amazon.nova', rate: { inputPerMTok: 0.8, outputPerMTok: 3.2 } },
]

/** Look up a rate. Returns null for unknown / custom providers with no default. */
export function lookupRate(providerId: string | null | undefined, model: string | null | undefined): TokenRate | null {
  if (!providerId) return null
  const pid = providerId.toLowerCase()
  const mid = (model ?? '').toLowerCase()
  if (mid) {
    const hits = MODEL_RATES
      .filter((r) => r.providerId === pid && mid.startsWith(r.model.toLowerCase()))
      .sort((a, b) => b.model.length - a.model.length)
    if (hits[0]) return hits[0].rate
  }
  return PROVIDER_DEFAULTS[pid] ?? null
}

export interface CostInput {
  providerId?: string | null
  model?: string | null
  /** Total tokens when split is unavailable. */
  tokens?: number | null
  promptTokens?: number | null
  completionTokens?: number | null
}

/**
 * Estimate USD cost. Returns null when the price table has no entry or when
 * there are no tokens — callers must leave cost empty, never invent.
 */
export function estimateCostUsd(input: CostInput): number | null {
  const rate = lookupRate(input.providerId, input.model)
  if (!rate) return null

  let prompt = input.promptTokens
  let completion = input.completionTokens
  if ((prompt == null || completion == null) && input.tokens != null && input.tokens >= 0) {
    prompt = Math.round(input.tokens * BLEND_INPUT_SHARE)
    completion = Math.max(0, input.tokens - prompt)
  }
  if (prompt == null || completion == null) return null
  if (prompt < 0 || completion < 0) return null

  const usd = (prompt / 1_000_000) * rate.inputPerMTok + (completion / 1_000_000) * rate.outputPerMTok
  // Micro-dollar precision is enough for Pareto; avoid float noise.
  return Math.round(usd * 1_000_000) / 1_000_000
}

/** Average of non-null costs, or null if none priced. */
export function avgCostUsd(values: Array<number | null | undefined>): number | null {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v))
  if (!xs.length) return null
  return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1_000_000) / 1_000_000
}
