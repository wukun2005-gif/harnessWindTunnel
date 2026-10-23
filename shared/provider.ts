// F4-6 online provider settings (PRD v1.1): ported from docStudio.
// Mirrors docStudio shared/src/types/provider.ts (ProviderConfig + presets) and
// client/src/components/Settings.tsx (13 always-rendered cards).
// Persistence mirrors docStudio: the raw apiKey is sent to the server settings
// store (server-data/settings.json, provider_all + legacy provider_{id} rows)
// and echoed back on load. Secrets never enter HarnessEvents, logs, or exports.
//
// 16 always-rendered cards since the OpenRouter decision card was added（三张判定模型卡
// 与 12 家 chat provider + custom 并列，可同时启用；见 shared/jev.ts）。
import { JEV_DEFAULT_BASE_URL, JEV_OPENCODE_DEFAULT_BASE_URL, JEV_OPENROUTER_DEFAULT_BASE_URL, JEV_PROVIDER_ID, JEV_PROVIDER_ID_OPENCODE, JEV_PROVIDER_ID_OPENROUTER } from "./jev";

export type ProviderId =
  | "kimi" | "glm" | "minimax" | "mimo" | "deepseek" | "gemini"
  | "qwen" | "bedrock" | "openrouter" | "opencode" | "volcengine" | "bailian"
  // 判定模型（非 chat）：TypeSafe Jev / OpenCode Jev / OpenRouter 判定 — System One，
  // POST {baseUrl}/systemone。与上面 12 家 chat provider 可同时启用；消费方见 shared/jev.ts。
  | "typesafe" | "opencode-jev" | "openrouter-jev";

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
  /** 判定模型 Provider 回退（失败时按排列顺序切换至下一张可用判定卡）。默认 true。 */
  enableDecisionProviderFallback?: boolean;
}

export interface PresetProvider {
  id: string;
  name: string;
  nameEn?: string;
  defaultBaseUrl: string;
  keyPlaceholder: string;
  desc: string;
  descEn?: string;
  /**
   * "chat"（默认）= 可被选作主模型跑 harness；"decision" = 判定模型（System One），
   * 只服务判分/闸门类复核，不能被选成主 chat 目标（该端点没有 /chat/completions）。
   * 消费方：设置屏卡片文案、server/playground/jevSettings.ts 的目标挑选。
   */
  kind?: "chat" | "decision";
}

/** All 16 cards are always rendered (docStudio has no add-provider flow); the last three are decision models. */
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
  // ── 判定模型（非 chat）：TypeSafe Jev / OpenCode Jev / OpenRouter 判定 ──
  // 端点 POST {baseUrl}/systemone（Bearer），不是 OpenAI 兼容端点；输出是结构化判定
  // （Choice / Score / Noul + 概率），不生成自由文本。可与上面任一 chat provider 同时启用，
  // 用途见 shared/jev.ts 与 PRD v1.1.3 第 13 章。
  // 位置固定在最后三张：server/playground 里「第一个启用的可用 provider」这类挑选逻辑按数组
  // 顺序取，判定模型排在末尾就不会被误当成主 chat 目标。
  { id: JEV_PROVIDER_ID, name: "TypeSafe Jev (判定模型)", nameEn: "TypeSafe Jev (decision model)", defaultBaseUrl: JEV_DEFAULT_BASE_URL, keyPlaceholder: "TypeSafe API key", desc: "判定模型（非 chat）：Playground 实况运行的唯一判分器，与主模型分开启用", descEn: "Decision model (not chat): the sole scorer for live Playground runs, enabled independently of chat models", kind: "decision" },
  { id: JEV_PROVIDER_ID_OPENCODE, name: "OpenCode Jev (判定模型)", nameEn: "OpenCode Jev (decision model)", defaultBaseUrl: JEV_OPENCODE_DEFAULT_BASE_URL, keyPlaceholder: "OpenCode Console API key", desc: "判定模型（非 chat）：OpenCode Console 托管的 Jev，Playground live 的唯一判分器", descEn: "Decision model (not chat): Jev hosted by OpenCode Console, the sole scorer for live Playground runs", kind: "decision" },
  { id: JEV_PROVIDER_ID_OPENROUTER, name: "OpenRouter 判定模型", nameEn: "OpenRouter decision models", defaultBaseUrl: JEV_OPENROUTER_DEFAULT_BASE_URL, keyPlaceholder: "sk-or-...", desc: "判定模型（非 chat）：OpenRouter 上的判定型号（Jev / Clef / Mercury Decide 等），可作为 Playground live 的唯一判分器", descEn: "Decision model (not chat): decision models on OpenRouter (Jev / Clef / Mercury Decide), usable as the sole scorer for live Playground runs", kind: "decision" },
];

export const CUSTOM_PRESET_ID = "custom";

/** 判定模型 provider（System One 协议，非 OpenAI 兼容）。 */
export const DECISION_PROVIDER_IDS: string[] = [JEV_PROVIDER_ID, JEV_PROVIDER_ID_OPENCODE, JEV_PROVIDER_ID_OPENROUTER];

/** true = 判定模型，不能当主 chat 目标（没有 /chat/completions，端点走 /systemone）。 */
export function isDecisionProvider(providerId: string): boolean {
  const preset = PRESET_PROVIDERS.find((p) => p.id === providerId);
  if (preset) return preset.kind === "decision";
  return DECISION_PROVIDER_IDS.includes(providerId);
}

export function trimBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}
