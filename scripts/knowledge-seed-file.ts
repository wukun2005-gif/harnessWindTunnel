// Seed one or more local files into the knowledge DB through the SAME pipeline
// as the Settings-screen upload (extract → preprocess → classify → chunk →
// filter → embed → store), with file-hash dedupe. Idempotent.
//
//   npx tsx scripts/knowledge-seed-file.ts <file> [<file> ...]
//   npx tsx scripts/knowledge-seed-file.ts --seed-dir   # all knowledge-seed files
import { readFileSync as rfs, readdirSync as rds, statSync as ss } from 'node:fs'
import { resolve, join } from 'node:path'
import crypto from 'node:crypto'
import { MIN_EMBED_LENGTH } from '../shared/knowledge'
import { extractText } from '../server/knowledge/extract'
import { classifyDocument, isNoise, isGarbled, preprocessText } from '../server/knowledge/preprocess'
import { chunkByDocumentType } from '../server/knowledge/chunker'
import {
  computeTextHash,
  findChunksByHashes,
  addChunks,
  addSource,
  addVectors,
  markChunkEmbedded,
  markSourceEmbedStatus,
  findDuplicateByHash,
} from '../server/knowledge/db'
import { embedderConfig } from '../server/knowledge/settings'
import { createRemoteEmbedder } from '../server/knowledge/embed'
import { invalidateBM25Index } from '../server/knowledge/bm25'

interface IngestChunk {
  id: string
  sourceId: string
  index: number
  text: string
  strategy: string
  metadata: Record<string, unknown>
  parentId?: string
}

const root = process.cwd()

function fileHashOf(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function filterChunks(chunks: ReturnType<typeof chunkByDocumentType>) {
  const seen = new Set<string>()
  const out: Array<{ text: string; metadata: Record<string, unknown>; parentId?: string }> = []
  for (const rc of chunks) {
    if (isNoise(rc.text) || isGarbled(rc.text)) continue
    const hash = crypto.createHash('sha256').update(rc.text.replace(/[\s　]/g, '').toLowerCase()).digest('hex')
    if (seen.has(hash)) continue
    seen.add(hash)
    const entry: { text: string; metadata: Record<string, unknown>; parentId?: string } = {
      text: rc.text,
      metadata: rc.metadata as unknown as Record<string, unknown>,
    }
    if (rc.parentId) entry.parentId = rc.parentId
    out.push(entry)
  }
  return out
}

async function seedFile(absPath: string): Promise<void> {
  const fileName = absPath.split('/').pop() ?? absPath
  const buf = rfs(absPath)
  const hash = fileHashOf(buf)
  const dup = findDuplicateByHash(hash)
  if (dup) {
    console.log(`SKIP (already in KB as "${dup.name}"): ${fileName}`)
    return
  }

  const extraction = await extractText(buf, fileName)
  const cleaned = preprocessText(extraction.text)
  const docCategory = classifyDocument(fileName, cleaned)
  const legalChunks = chunkByDocumentType(cleaned, docCategory, { fileName, documentCategory: docCategory })
  const filtered = filterChunks(legalChunks)

  const sourceId = `ks-seed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  addSource({
    id: sourceId,
    name: fileName,
    type: 'file',
    format: fileName.toLowerCase().split('.').pop() ?? 'txt',
    mediaType: extraction.mediaType,
    size: buf.length,
    fileHash: hash,
    chunkCount: filtered.length,
    embedStatus: 'processing',
  })

  const chunks: IngestChunk[] = filtered.map((rc, i) => {
    const chunk: IngestChunk = {
      id: `${sourceId}-c${i}`,
      sourceId,
      index: i,
      text: rc.text,
      strategy: 'auto',
      metadata: rc.metadata,
    }
    if (rc.parentId) chunk.parentId = `${sourceId}-${rc.parentId}`
    return chunk
  })
  addChunks(chunks)

  const emb = embedderConfig()
  if (emb && chunks.length > 0) {
    const hashes = chunks.map((c) => computeTextHash(c.text))
    const existing = findChunksByHashes(hashes)
    const toEmbed: IngestChunk[] = []
    for (let i = 0; i < chunks.length; i++) {
      const h = hashes[i]
      const c = chunks[i]
      if (!h || !c) continue
      const ex = existing.get(h)
      if (ex) {
        addVectors([{ chunkId: c.id, vector: ex.vector, modelId: emb.modelId }])
        markChunkEmbedded(c.id)
      } else {
        toEmbed.push(c)
      }
    }
    const valid = toEmbed.filter((c) => c.text.length >= MIN_EMBED_LENGTH)
    for (const c of toEmbed) if (c.text.length < MIN_EMBED_LENGTH) markChunkEmbedded(c.id)
    const embedder = createRemoteEmbedder(emb)
    const BATCH = 100
    for (let i = 0; i < valid.length; i += BATCH) {
      const batch = valid.slice(i, i + BATCH)
      const vectors = await embedder.embed(batch.map((c) => c.text))
      addVectors(batch.map((c, j) => ({ chunkId: c.id, vector: vectors[j]!, modelId: emb.modelId })))
      for (const c of batch) markChunkEmbedded(c.id)
      console.log(`  ${fileName}: embedded ${Math.min(i + BATCH, valid.length)}/${valid.length}`)
    }
  } else {
    for (const c of chunks) markChunkEmbedded(c.id)
  }

  invalidateBM25Index()
  markSourceEmbedStatus(sourceId, 'done')
  console.log(`✅ ${fileName}: category=${docCategory}, ${legalChunks.length} → ${filtered.length} chunks${emb ? ' (embedded)' : ' (BM25 only)'}`)
}

async function main() {
  const args = process.argv.slice(2)
  let paths: string[]
  if (args.includes('--seed-dir')) {
    const dir = resolve(root, 'server-data', 'knowledge-seed')
    paths = rds(dir)
      .filter((f) => !ss(join(dir, f)).isDirectory())
      .map((f) => join(dir, f))
  } else {
    paths = args.map((p) => resolve(p))
  }
  if (paths.length === 0) {
    console.error('usage: tsx scripts/knowledge-seed-file.ts <file> ... | --seed-dir')
    process.exit(1)
  }
  for (const p of paths) await seedFile(p)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
