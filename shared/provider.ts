// F4-6 online provider settings (PRD v1.1): ported from docStudio.
// Mirrors docStudio shared/src/types/provider.ts (ProviderConfig + presets) and
// client/src/components/Settings.tsx (13 always-rendered cards).
// Persistence mirrors docStudio: the raw apiKey is sent to the server settings
// store (server-data/settings.json, provider_all + legacy provider_{id} rows)
// and echoed back on load. Secrets never enter HarnessEvents, logs, or exports.

export type ProviderId =
  | "kimi" | "glm" | "minimax" | "mimo" | "deepseek" | "gemini"
  | "qwen" | "bedrock" | "openrouter" | "opencode" | "volcengine" | "bailian";

export interface ModelInfo {
  id: string;
  recommendation?: string;
  rpm?: number;
  rpd?: number;
  tpm?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  isReasoning?: boolean;
  supportsVision?: boolean;
  supportsStructuredOutput?: boolean;
  supportsFunctionCalling?: boolean;
}

/** Provider config, docStudio ProviderConfig shape (client + server agree). */
export interface ProviderConfig {
  providerId: string;
  apiKey?: string;
  apiKeyRef?: string;
  baseUrl?: string;
  defaultModelId?: string;
  modelIds?: string[];
  modelFallbacks?: string[];
  enabled: boolean;
  enableModelFallback?: boolean;
}

export interface AppSettings {
  providers: ProviderConfig[];
  enableProviderFallback?: boolean;
}

export interface PresetProvider {
  id: string;
  name: string;
  nameEn?: string;
  defaultBaseUrl: string;
  keyPlaceholder: string;
  desc: string;
  descEn?: string;
}

/** All 13 cards are always rendered (docStudio has no add-provider flow). */
export const PRESET_PROVIDERS: PresetProvider[] = [
  { id: "gemini", name: "Gemini (Google)", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta", keyPlaceholder: "AIza...", desc: "Google Gemini 系列", descEn: "Google Gemini series" },
  { id: "openrouter", name: "OpenRouter", defaultBaseUrl: "https://openrouter.ai/api/v1", keyPlaceholder: "sk-or-...", desc: "多模型聚合平台", descEn: "Multi-model aggregation platform" },
  { id: "deepseek", name: "DeepSeek", defaultBaseUrl: "https://api.deepseek.com/v1", keyPlaceholder: "sk-...", desc: "DeepSeek AI" },
  { id: "qwen", name: "Qwen (通义千问)", nameEn: "Qwen (Tongyi)", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyPlaceholder: "sk-...", desc: "阿里通义千问", descEn: "Alibaba Tongyi Qianwen" },
  { id: "kimi", name: "Kimi (月之暗面)", nameEn: "Kimi (Moonshot)", defaultBaseUrl: "https://api.moonshot.cn/v1", keyPlaceholder: "sk-...", desc: "月之暗面 Kimi", descEn: "Moonshot AI Kimi" },
  { id: "glm", name: "GLM (智谱)", nameEn: "GLM (Zhipu)", defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4", keyPlaceholder: "...", desc: "智谱 GLM", descEn: "Zhipu GLM" },
  { id: "minimax", name: "MiniMax", defaultBaseUrl: "https://api.minimax.chat/v1", keyPlaceholder: "eyJhb...", desc: "MiniMax AI" },
  { id: "opencode", name: "OpenCode", defaultBaseUrl: "https://opencode.ai/v1", keyPlaceholder: "sk-...", desc: "OpenCode AI" },
  { id: "mimo", name: "MiMo (Xiaomi)", defaultBaseUrl: "https://api.xiaomi.com/v1", keyPlaceholder: "tp-...", desc: "小米 MiMo", descEn: "Xiaomi MiMo" },
  { id: "volcengine", name: "Volcengine (火山引擎)", nameEn: "Volcengine", defaultBaseUrl: "https://ark.cn-beijing.volces.com/api/v3", keyPlaceholder: "ark-...", desc: "火山引擎豆包", descEn: "Volcengine Doubao" },
  { id: "bailian", name: "Bailian (百炼/阿里)", nameEn: "Bailian (Alibaba)", defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", keyPlaceholder: "sk-...", desc: "阿里百炼", descEn: "Alibaba Bailian" },
  { id: "bedrock", name: "AWS Bedrock", defaultBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com", keyPlaceholder: "AWS access key ID", desc: "Amazon Bedrock" },
  { id: "custom", name: "Custom (OpenAI Compatible)", defaultBaseUrl: "", keyPlaceholder: "sk-...", desc: "自定义 OpenAI 兼容端点", descEn: "Custom OpenAI-compatible endpoint" },
];

export const CUSTOM_PRESET_ID = "custom";

export function trimBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}
