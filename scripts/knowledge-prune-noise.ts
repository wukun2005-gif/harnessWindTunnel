/**
 * 知识库存量噪声清理（一次性维护工具，可重复运行）。
 *
 * 新上传走 server/knowledge/routes.ts 的 filterChunks，已在入库前过滤；
 * 本脚本用于清理规则加强前已经入库的噪声 chunk（典型：PDF 目录页
 * "序号. 标题 ........ 页码" 条目），并删除调试残留 source。
 *
 * 判定规则单一来源：server/knowledge/preprocess.ts 的 isNoise()。
 * 运行：npx tsx scripts/knowledge-prune-noise.ts
 * 注意：运行前停止 :4000 server，避免 SQLite 并发写。
 */
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isNoise } from '../server/knowledge/preprocess'

const dbPath = process.env['HWT_KNOWLEDGE_DB'] ?? path.resolve(process.cwd(), 'server-data', 'knowledge.db')
const db = new DatabaseSync(dbPath)

interface ChunkRow {
  id: string
  source_id: string
  text: string
}

const DEBUG_SOURCE_RE = /^kb-log-test/i

function pruneNoiseChunks(): number {
  const chunks = db.prepare('SELECT id, source_id, text FROM kb_chunks').all() as unknown as ChunkRow[]
  const noiseIds = chunks.filter((c) => isNoise(c.text)).map((c) => c.id)
  if (noiseIds.length === 0) return 0

  const tx = db.exec.bind(db)
  tx('BEGIN')
  try {
    const delVec = db.prepare('DELETE FROM kb_vectors WHERE chunk_id = ?')
    const delChunk = db.prepare('DELETE FROM kb_chunks WHERE id = ?')
    for (const id of noiseIds) {
      delVec.run(id)
      delChunk.run(id)
    }
    tx('COMMIT')
  } catch (err) {
    tx('ROLLBACK')
    throw err
  }
  return noiseIds.length
}

function pruneDebugSources(): string[] {
  const sources = db.prepare('SELECT id, name FROM kb_sources').all() as Array<{ id: string; name: string }>
  const removed: string[] = []
  for (const s of sources) {
    if (!DEBUG_SOURCE_RE.test(s.name)) continue
    db.prepare('DELETE FROM kb_vectors WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE source_id = ?)').run(s.id)
    db.prepare('DELETE FROM kb_chunks WHERE source_id = ?').run(s.id)
    db.prepare('DELETE FROM kb_sources WHERE id = ?').run(s.id)
    removed.push(s.name)
  }
  return removed
}

function recount(): void {
  const rows = db.prepare('SELECT id FROM kb_sources').all() as Array<{ id: string }>
  const upd = db.prepare('UPDATE kb_sources SET chunk_count = (SELECT COUNT(*) FROM kb_chunks WHERE source_id = ?) WHERE id = ?')
  for (const r of rows) upd.run(r.id, r.id)
}

const removedNoise = pruneNoiseChunks()
const removedSources = pruneDebugSources()
recount()

const stats = db
  .prepare('SELECT (SELECT COUNT(*) FROM kb_sources) AS sources, (SELECT COUNT(*) FROM kb_chunks) AS chunks, (SELECT COUNT(*) FROM kb_vectors) AS vectors')
  .get() as Record<string, number>

console.log(JSON.stringify({ ok: true, removedNoiseChunks: removedNoise, removedDebugSources: removedSources, ...stats }, null, 2))
db.close()
