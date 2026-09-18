// F4-6 online provider settings (PRD v1.1, docStudio architecture in spirit).
// Secrets policy: the server keyStore holds raw apiKeys in memory only and
// NEVER persists, logs, or returns them. The client persists everything
// EXCEPT the key (localStorage); the key lives in the edit form state and is
// sent once to the keyStore on save. Connections reference keys by apiKeyRef.

export interface VendorPreset {
  id: string
  name: string
  baseUrl: string
  keyPlaceholder: string
  models: string[]
}

export const VENDOR_PRESETS: VendorPreset[] = [
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1', keyPlaceholder: 'sk-… (Moonshot)', models: ['kimi-k2', 'kimi-k2-thinking'] },
  { id: 'glm', name: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', keyPlaceholder: '… (Zhipu)', models: ['glm-4.6', 'glm-4.5'] },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.io/v1', keyPlaceholder: '… (MiniMax)', models: ['MiniMax-M2', 'MiniMax-M1'] },
  { id: 'mimo', name: 'MiMo', baseUrl: 'https://api.xiaomimimo.com/v1', keyPlaceholder: '… (Xiaomi MiMo)', models: ['mimo-7b', 'mimo-flash'] },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyPlaceholder: 'sk-… (DeepSeek)', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyPlaceholder: 'AI… (Google AI Studio)', models: ['gemini-3-pro', 'gemini-3-flash'] },
  { id: 'qwen', name: 'Qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyPlaceholder: 'sk-… (Alibaba Bailian)', models: ['qwen3-max', 'qwen3-flash'] },
  { id: 'bedrock', name: 'Bedrock', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', keyPlaceholder: '… (AWS Bedrock)', models: ['claude-5-class', 'nova-pro'] },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyPlaceholder: 'sk-or-…', models: ['openrouter/auto'] },
  { id: 'opencode', name: 'OpenCode', baseUrl: 'https://opencode.ai/api/v1', keyPlaceholder: '… (OpenCode)', models: ['opencode-default'] },
  { id: 'volcengine', name: 'Volcengine', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', keyPlaceholder: '… (Huoshang)', models: ['doubao-seed-1.6', 'doubao-seed-flash'] },
  { id: 'bailian', name: 'Bailian', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyPlaceholder: 'sk-… (Bailian)', models: ['qwen-plus', 'qwen-turbo'] },
]

export const CUSTOM_PRESET_ID = 'custom'

export function customPreset(baseUrl: string): VendorPreset {
  return { id: CUSTOM_PRESET_ID, name: 'Custom (OpenAI Compatible)', baseUrl, keyPlaceholder: 'sk-… / any token', models: ['custom-model'] }
}

export interface ProviderConnection {
  /** Stable id: vendor preset id, or `custom-<n>` for extra endpoints. */
  id: string
  vendorId: string
  name: string
  baseUrl: string
  /** Reference into the server keyStore; the raw key is never stored here. */
  apiKeyRef: string | null
  models: string[]
  defaultModel: string
  /** Ordered fallback chain (subset of models, first = primary after default). */
  fallback: string[]
  enabled: boolean
  collapsed?: boolean
}

export function trimBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, '')
}

export function blankConnection(vendor: VendorPreset, n = 0): ProviderConnection {
  const id = vendor.id === CUSTOM_PRESET_ID ? `${CUSTOM_PRESET_ID}-${Date.now().toString(36)}${n ? `-${n}` : ''}` : vendor.id
  return {
    id,
    vendorId: vendor.id,
    name: vendor.name,
    baseUrl: vendor.baseUrl,
    apiKeyRef: null,
    models: [...vendor.models],
    defaultModel: vendor.models[0] ?? '',
    fallback: vendor.models.slice(1),
    enabled: true,
  }
}
