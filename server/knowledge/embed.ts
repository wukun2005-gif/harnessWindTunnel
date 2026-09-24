/**
 * 远程 Embedding API（纯远程，cr-1：无本地模型）
 * Ported from patentExaminator routes/knowledge.ts createRemoteEmbedder +
 * providers/test embedding branch.
 */

import type { EmbedderConfig } from './settings'

const FETCH_TIMEOUT_MS = 30_000

export interface RemoteEmbedder {
  modelId: string
  embed(texts: string[]): Promise<number[][]>
}

/** 创建远程 embedding 函数（baseUrl 自动补 /v1，500 字符截断） */
export function createRemoteEmbedder(config: EmbedderConfig): RemoteEmbedder {
  return {
    modelId: config.modelId,
    embed: async (texts: string[]): Promise<number[][]> => {
      const baseUrl = config.baseUrl.endsWith('/v1') ? config.baseUrl : `${config.baseUrl}/v1`
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.modelId,
          input: texts.map((t) => (t.length > 500 ? t.slice(0, 500) : t)),
        }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })

      if (!response.ok) {
        throw new Error(`Remote embedding API error: ${response.status} ${response.statusText}`)
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[] }>
      }

      return data.data.map((d) => d.embedding)
    },
  }
}

/** 测试 Embedding Provider 连接（providers/test 的 embedding 分支） */
export async function testEmbeddingProvider(input: {
  baseUrl: string
  apiKey: string
  modelId: string
}): Promise<{ ok: boolean; error?: string }> {
  const embeddingsUrl = input.baseUrl.endsWith('/v1') ? `${input.baseUrl}/embeddings` : `${input.baseUrl}/v1/embeddings`
  try {
    const response = await fetch(embeddingsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.modelId,
        input: ['test'],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })

    const body = await response.text()
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}: ${body.slice(0, 300)}` }
    }

    // 验证响应是合法 JSON 且包含 embedding 数据
    try {
      const data = JSON.parse(body) as { data?: Array<{ embedding?: number[] }> }
      if (!data.data?.[0]?.embedding) {
        return { ok: false, error: '响应格式异常: 缺少 embedding 数据' }
      }
    } catch {
      return { ok: false, error: `响应不是合法 JSON: ${body.slice(0, 200)}` }
    }

    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
