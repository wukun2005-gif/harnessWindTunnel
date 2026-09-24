// Knowledge base types + embedding / re-ranker provider presets.
// Ported from patentExaminator shared/src/types/knowledge.ts and the
// nf-9 knowledge provider section of shared/src/types/agents.ts so the
// settings screen (`#/settings`) can configure a remote embedding API and a
// remote re-ranker API exactly like patentExaminator does.

// ── Sources ─────────────────────────────────────────────

export type KnowledgeSourceType = 'file' | 'url'

export type KnowledgeFileFormat =
  | 'pdf'
  | 'txt'
  | 'md'
  | 'docx'
  | 'doc'
  | 'json'
  | 'xlsx'
  | 'xls'
  | 'csv'
  | 'jpg'
  | 'jpeg'
  | 'png'

export type KnowledgeMediaType = 'text' | 'table' | 'image'

export type KnowledgeEmbedStatus = 'pending' | 'processing' | 'done' | 'completed' | 'failed'

/** Knowledge库来源元数据 (kb_sources row) */
export interface KnowledgeSource {
  id: string
  type: KnowledgeSourceType
  name: string
  format: string
  mediaType: string
  size: number
  fileHash: string | null
  sourceUrl: string | null
  chunkCount: number
  embedStatus: KnowledgeEmbedStatus
  createdAt: string
  updatedAt: string
}

// ── Chunks ──────────────────────────────────────────────

export type ChunkStrategy =
  | 'section'
  | 'article'
  | 'case-point'
  | 'heading'
  | 'json-key'
  | 'table-row'
  | 'image-ocr'
  | 'auto'

/** 切片元数据 (legalChunker 输出，随 chunk 一起存储) */
export interface ChunkMetadata {
  fileName: string
  mediaType: KnowledgeMediaType
  documentCategory?: string
  chapter?: string
  section?: string
  article?: string
  paragraph?: string
  articleRefs?: string[]
  sectionId?: string
  articleId?: string
  sheetName?: string
  rowIndex?: number
  pageNumber?: number
  depth?: number
  chunkVersion?: number
  [key: string]: unknown
}

export interface KnowledgeChunkRecord {
  id: string
  sourceId: string
  index: number
  text: string
  strategy: string
  metadata: ChunkMetadata
  embedded: boolean
  createdAt: string
}

/** 检索命中（POST /api/knowledge/search 返回项） */
export interface KnowledgeSearchHit {
  chunkId: string
  text: string
  metadata: ChunkMetadata
  score: number
}

// ── Config ──────────────────────────────────────────────

export interface KnowledgeConfig {
  /** 是否启用知识库 */
  enabled: boolean
  /** 检索返回的 top-k 数量 */
  topK: number
  /** 相似度阈值（低于此值不返回） */
  scoreThreshold: number
}

export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  enabled: false,
  topK: 5,
  scoreThreshold: 0.3,
}

export const ACCEPTED_KNOWLEDGE_FORMATS = '.pdf,.txt,.md,.docx,.doc,.json,.xlsx,.xls,.csv,.jpg,.jpeg,.png'

// ── nf-9: 知识库独立 API Provider（embedding / reranker） ──

export type KnowledgeProviderType = 'embedding' | 'reranker'

export interface KnowledgeProviderConnection {
  providerType: KnowledgeProviderType
  providerId: string
  displayName: string
  baseUrl: string
  /** 服务端保存的 key；下发给前端时被替换为 '' + hasKey 标记（B-041） */
  apiKeyRef: string
  modelId: string
  availableModels: string[]
  enabled: boolean
}

export interface PresetKnowledgeProvider {
  providerType: KnowledgeProviderType
  providerId: string
  displayName: string
  desc: string
  baseUrl: string
  defaultModelId: string
  keyPlaceholder: string
}

export const PRESET_KNOWLEDGE_PROVIDERS: PresetKnowledgeProvider[] = [
  {
    providerType: 'embedding',
    providerId: 'siliconflow',
    displayName: '硅基流动 Embedding',
    desc: 'SiliconFlow Embedding API（免费额度）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModelId: 'BAAI/bge-m3',
    keyPlaceholder: 'sk-...',
  },
  {
    providerType: 'reranker',
    providerId: 'siliconflow',
    displayName: '硅基流动 Re-ranker',
    desc: 'SiliconFlow Re-ranker API（免费额度）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    defaultModelId: 'BAAI/bge-reranker-v2-m3',
    keyPlaceholder: 'sk-...',
  },
]

/** 知识库入库流水线步骤数（与 patentExaminator 上传 SSE 进度一致） */
export const KNOWLEDGE_UPLOAD_STEPS = 5

/** 短 chunk 低于该长度不送 embedding（patentExaminator B-033 优化） */
export const MIN_EMBED_LENGTH = 50
