// 服务端知识库存储 — node:sqlite + 向量化
// Ported from patentExaminator server/src/lib/knowledgeDb.ts (better-sqlite3 →
// the Node built-in `node:sqlite` DatabaseSync; no native dependency is added).
// Schema is identical: kb_sources / kb_chunks / kb_vectors (+ text_hash and
// parent_id columns for resume-after-restart and parent-child retrieval).
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'

// 数据库路径：环境变量优先（测试隔离），默认 server-data/knowledge.db
const _defaultDbPath = process.env['HWT_KNOWLEDGE_DB'] ?? path.resolve(process.cwd(), 'server-data', 'knowledge.db')

let db: DatabaseSync | null = null
let dbOverridePath: string | null = null

function getKnowledgeDb(): DatabaseSync {
  if (db) return db

  const dbPath = dbOverridePath ?? _defaultDbPath
  const dataDir = path.dirname(dbPath)

  if (dbPath !== ':memory:' && !fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  db = new DatabaseSync(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_sources (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      format TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      file_hash TEXT,
      source_url TEXT,
      chunk_count INTEGER DEFAULT 0,
      embed_status TEXT DEFAULT 'pending',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL,
      strategy TEXT DEFAULT 'auto',
      metadata TEXT DEFAULT '{}',
      embedded INTEGER DEFAULT 0,
      text_hash TEXT,
      parent_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (source_id) REFERENCES kb_sources(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS kb_vectors (
      chunk_id TEXT PRIMARY KEY,
      vector TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES kb_chunks(id) ON DELETE CASCADE
    );
  `)

  // 断点续传：text_hash 索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON kb_chunks(text_hash)`)
  // Parent-Child Chunk 模式：parent_id 索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_parent_id ON kb_chunks(parent_id)`)

  return db
}

/** Multi-row write helper — node:sqlite has no db.transaction(); BEGIN/COMMIT manually. */
function withTransaction(run: () => void): void {
  const database = getKnowledgeDb()
  database.exec('BEGIN')
  try {
    run()
    database.exec('COMMIT')
  } catch (err) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // already rolled back / no active transaction
    }
    throw err
  }
}

export function knowledgeDbFile(): string {
  return dbOverridePath ?? _defaultDbPath
}

// ── Sources ─────────────────────────────────────────

export interface KnowledgeDbSource {
  id: string
  name: string
  type: string
  format: string
  mediaType: string
  size: number
  fileHash: string | null
  sourceUrl: string | null
  chunkCount: number
  embedStatus: string
  createdAt: string
  updatedAt: string
}

export function addSource(source: {
  id: string
  name: string
  type: string
  format: string
  mediaType: string
  size: number
  fileHash?: string
  sourceUrl?: string
  chunkCount: number
  embedStatus: string
}): void {
  const database = getKnowledgeDb()
  const now = new Date().toISOString()
  database
    .prepare(
      `INSERT OR REPLACE INTO kb_sources
    (id, name, type, format, media_type, size, file_hash, source_url, chunk_count, embed_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      source.id,
      source.name,
      source.type,
      source.format,
      source.mediaType,
      source.size,
      source.fileHash ?? null,
      source.sourceUrl ?? null,
      source.chunkCount,
      source.embedStatus,
      now,
      now,
    )
}

export function getAllSources(): KnowledgeDbSource[] {
  const database = getKnowledgeDb()
  return (database.prepare('SELECT * FROM kb_sources ORDER BY rowid').all() as Array<Record<string, unknown>>).map((r) => ({
    id: r['id'] as string,
    name: r['name'] as string,
    type: r['type'] as string,
    format: r['format'] as string,
    mediaType: r['media_type'] as string,
    size: Number(r['size'] ?? 0),
    fileHash: (r['file_hash'] as string | null) ?? null,
    sourceUrl: (r['source_url'] as string | null) ?? null,
    chunkCount: Number(r['chunk_count'] ?? 0),
    embedStatus: r['embed_status'] as string,
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string,
  }))
}

export function deleteSource(id: string): void {
  const database = getKnowledgeDb()
  // node:sqlite enforces FK pragma off by default; delete children explicitly
  // (same order the source project relies on).
  const chunkIds = (
    database.prepare('SELECT id FROM kb_chunks WHERE source_id = ?').all(id) as Array<{ id: string }>
  ).map((r) => r.id)
  withTransaction(() => {
    for (const chunkId of chunkIds) {
      database.prepare('DELETE FROM kb_vectors WHERE chunk_id = ?').run(chunkId)
    }
    database.prepare('DELETE FROM kb_chunks WHERE source_id = ?').run(id)
    database.prepare('DELETE FROM kb_sources WHERE id = ?').run(id)
  })
}

// ── Chunks ──────────────────────────────────────────

export interface KnowledgeDbChunk {
  id: string
  sourceId: string
  index: number
  text: string
  strategy: string
  metadata: string
  embedded: number
  textHash: string | null
  parentId: string | null
}

export function addChunks(
  chunks: Array<{
    id: string
    sourceId: string
    index: number
    text: string
    strategy: string
    metadata: Record<string, unknown>
    parentId?: string
  }>,
): void {
  const database = getKnowledgeDb()
  const stmt = database.prepare(
    `INSERT OR REPLACE INTO kb_chunks
    (id, source_id, idx, text, strategy, metadata, embedded, text_hash, parent_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  )
  const now = new Date().toISOString()
  withTransaction(() => {
    for (const chunk of chunks) {
      const textHash = computeTextHash(chunk.text)
      stmt.run(
        chunk.id,
        chunk.sourceId,
        chunk.index,
        chunk.text,
        chunk.strategy,
        JSON.stringify(chunk.metadata),
        textHash,
        chunk.parentId ?? null,
        now,
      )
    }
  })
}

/** 计算文本的 MD5 hash（用于断点续传） */
export function computeTextHash(text: string): string {
  return crypto.createHash('md5').update(text).digest('hex')
}

/** 文本修正：更新 chunk 文本并作废旧向量（调用方负责重嵌），原子提交。返回是否真的改动。 */
export function updateChunkTextAndInvalidate(chunkId: string, text: string): boolean {
  const database = getKnowledgeDb()
  const row = database.prepare('SELECT text FROM kb_chunks WHERE id = ?').get(chunkId) as { text: string } | undefined
  if (!row || row.text === text) return false
  withTransaction(() => {
    database.prepare('UPDATE kb_chunks SET text = ?, text_hash = ?, embedded = 0 WHERE id = ?').run(text, computeTextHash(text), chunkId)
    database.prepare('DELETE FROM kb_vectors WHERE chunk_id = ?').run(chunkId)
  })
  return true
}

/** 断点续传：批量查找已有向量（按 text hash 匹配，跨文档复用） */
export function findChunksByHashes(hashes: string[]): Map<string, { chunkId: string; vector: number[] }> {
  const database = getKnowledgeDb()
  const result = new Map<string, { chunkId: string; vector: number[] }>()
  const batchSize = 100
  for (let i = 0; i < hashes.length; i += batchSize) {
    const batch = hashes.slice(i, i + batchSize)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = database
      .prepare(
        `SELECT c.text_hash, c.id as chunk_id, v.vector
       FROM kb_chunks c
       INNER JOIN kb_vectors v ON c.id = v.chunk_id
       WHERE c.text_hash IN (${placeholders}) AND c.embedded = 1`,
      )
      .all(...batch) as Array<{ text_hash: string; chunk_id: string; vector: string }>

    for (const row of rows) {
      let vector: number[] = []
      try {
        vector = JSON.parse(row.vector) as number[]
      } catch {
        console.error(`[knowledge] Malformed vector for chunk=${row.chunk_id}, hash=${row.text_hash}`)
      }
      result.set(row.text_hash, { chunkId: row.chunk_id, vector })
    }
  }
  return result
}

export function getUnembeddedChunks(): Array<{
  id: string
  sourceId: string
  index: number
  text: string
  strategy: string
  metadata: string
  embedded: number
}> {
  const database = getKnowledgeDb()
  return database
    .prepare(
      'SELECT id, source_id as sourceId, idx as `index`, text, strategy, metadata, embedded FROM kb_chunks WHERE embedded = 0',
    )
    .all() as Array<{
    id: string
    sourceId: string
    index: number
    text: string
    strategy: string
    metadata: string
    embedded: number
  }>
}

export function markChunkEmbedded(chunkId: string): void {
  const database = getKnowledgeDb()
  database.prepare('UPDATE kb_chunks SET embedded = 1 WHERE id = ?').run(chunkId)
}

export function markSourceEmbedStatus(sourceId: string, status: string): void {
  const database = getKnowledgeDb()
  database
    .prepare('UPDATE kb_sources SET embed_status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), sourceId)
}

export function getAllChunks(): KnowledgeDbChunk[] {
  const database = getKnowledgeDb()
  return (
    database
      .prepare(
        'SELECT id, source_id as sourceId, idx as `index`, text, strategy, metadata, embedded, text_hash as textHash, parent_id as parentId FROM kb_chunks',
      )
      .all() as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r['id'] as string,
    sourceId: r['sourceId'] as string,
    index: Number(r['index'] ?? 0),
    text: r['text'] as string,
    strategy: r['strategy'] as string,
    metadata: r['metadata'] as string,
    embedded: Number(r['embedded'] ?? 0),
    textHash: (r['textHash'] as string | null) ?? null,
    parentId: (r['parentId'] as string | null) ?? null,
  }))
}

export function getChunksBySourceId(
  sourceId: string,
  limit = 20,
): Array<{ id: string; index: number; text: string; metadata: string }> {
  const database = getKnowledgeDb()
  return database
    .prepare('SELECT id, idx as `index`, text, metadata FROM kb_chunks WHERE source_id = ? ORDER BY idx LIMIT ?')
    .all(sourceId, limit) as Array<{ id: string; index: number; text: string; metadata: string }>
}

/** 获取 chunk 及其 parent chunk 的文本（用于 Parent-Child 注入） */
export function getChunksWithParent(
  chunkIds: string[],
): Map<string, { childText: string; parentText: string; metadata: string }> {
  const database = getKnowledgeDb()
  const result = new Map<string, { childText: string; parentText: string; metadata: string }>()
  if (chunkIds.length === 0) return result

  const placeholders = chunkIds.map(() => '?').join(', ')
  const childRows = database
    .prepare(`SELECT id, text, metadata, parent_id FROM kb_chunks WHERE id IN (${placeholders})`)
    .all(...chunkIds) as Array<{ id: string; text: string; metadata: string; parent_id: string | null }>

  const parentIds = [...new Set(childRows.map((r) => r.parent_id).filter((id): id is string => id !== null))]

  const parentMap = new Map<string, string>()
  if (parentIds.length > 0) {
    const parentPlaceholders = parentIds.map(() => '?').join(',')
    const parentRows = database
      .prepare(`SELECT id, text FROM kb_chunks WHERE id IN (${parentPlaceholders})`)
      .all(...parentIds) as Array<{ id: string; text: string }>
    for (const row of parentRows) {
      parentMap.set(row.id, row.text)
    }
  }

  for (const child of childRows) {
    const parentText = child.parent_id ? (parentMap.get(child.parent_id) ?? child.text) : child.text
    result.set(child.id, { childText: child.text, parentText, metadata: child.metadata })
  }

  return result
}

// ── Vectors ─────────────────────────────────────────

export function addVectors(vectors: Array<{ chunkId: string; vector: number[]; modelId: string }>): void {
  const database = getKnowledgeDb()
  const stmt = database.prepare(
    `INSERT OR REPLACE INTO kb_vectors
    (chunk_id, vector, model_id, created_at) VALUES (?, ?, ?, ?)`,
  )
  const now = new Date().toISOString()
  withTransaction(() => {
    for (const vec of vectors) {
      stmt.run(vec.chunkId, JSON.stringify(vec.vector), vec.modelId, now)
    }
  })
}

export function getAllVectors(): Array<{ chunkId: string; vector: number[]; modelId: string }> {
  const database = getKnowledgeDb()
  return (
    database.prepare('SELECT * FROM kb_vectors').all() as Array<Record<string, unknown>>
  ).map((row) => ({
    chunkId: row['chunk_id'] as string,
    vector: (() => {
      try {
        return JSON.parse(row['vector'] as string) as number[]
      } catch {
        console.error(`[knowledge] Malformed vector for chunk=${row['chunk_id']}`)
        return []
      }
    })(),
    modelId: row['model_id'] as string,
  }))
}

export function getStats(): { sourceCount: number; chunkCount: number; embeddedCount: number } {
  const database = getKnowledgeDb()
  const count = (sql: string): number => Number((database.prepare(sql).get() as { c: number }).c)
  return {
    sourceCount: count('SELECT COUNT(*) as c FROM kb_sources'),
    chunkCount: count('SELECT COUNT(*) as c FROM kb_chunks'),
    embeddedCount: count('SELECT COUNT(*) as c FROM kb_chunks WHERE embedded = 1'),
  }
}

export function clearAll(): void {
  const database = getKnowledgeDb()
  database.exec('DELETE FROM kb_vectors')
  database.exec('DELETE FROM kb_chunks')
  database.exec('DELETE FROM kb_sources')
}

export function findDuplicateByHash(fileHash: string): { id: string; name: string } | null {
  const database = getKnowledgeDb()
  const row = database
    .prepare('SELECT id, name FROM kb_sources WHERE file_hash = ? LIMIT 1')
    .get(fileHash) as { id: string; name: string } | undefined
  return row ?? null
}

/** 关闭并重置数据库连接 */
export function closeKnowledgeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

/** 测试隔离 — 重置 knowledgeDb 到指定路径（":memory:" 或临时文件） */
export function resetKnowledgeDbForTesting(testPath: string): void {
  closeKnowledgeDb()
  dbOverridePath = testPath
}
