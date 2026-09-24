// A/B 记录（M1 §17.9）—— 每次旁路复核落一条，append-only JSONL。
// 聚合指标不入库，分析视图现算。
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { JevReviewRecord } from '../../shared/jev'
import { jevWarn } from './jevLog'

export function reviewsFile(): string {
  const override = process.env['HWT_JEV_REVIEWS_FILE']
  if (override) return resolve(override)
  return resolve(process.cwd(), 'server-data', 'jev-reviews.jsonl')
}

/** 记录落盘失败永不抛错：不能让记账影响判分（只记一行日志）。 */
export function saveReview(rec: JevReviewRecord): void {
  try {
    const file = reviewsFile()
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8')
  } catch (err) {
    jevWarn(`saveReview failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export interface ReviewFilter {
  task?: string
  domain?: string
  batch?: string
  from?: string
  to?: string
  limit?: number
}

function isRecord(v: unknown): v is JevReviewRecord {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['id'] === 'string' && typeof o['taskId'] === 'string' && typeof o['time'] === 'string'
}

export function listReviews(f: ReviewFilter = {}): JevReviewRecord[] {
  let lines: string[]
  try {
    lines = readFileSync(reviewsFile(), 'utf8').split('\n')
  } catch {
    return []
  }
  const out: JevReviewRecord[] = []
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    try {
      const parsed = JSON.parse(s) as unknown
      if (isRecord(parsed)) out.push(parsed)
    } catch {
      /* skip corrupt lines */
    }
  }
  const filtered = out.filter(
    (r) =>
      (!f.task || r.taskId === f.task) &&
      (!f.domain || r.domain === f.domain) &&
      (!f.batch || r.batchId === f.batch) &&
      (!f.from || r.time >= f.from) &&
      (!f.to || r.time <= f.to),
  )
  const limit = f.limit != null && Number.isFinite(f.limit) ? Math.min(10_000, Math.max(1, Math.floor(f.limit))) : 2000
  return filtered.slice(-limit)
}

/**
 * 清除记录：按批次（重跑前清掉失败的那一批）或全部。原子写（tmp + rename）。
 * 返回删掉的条数。
 */
export function clearReviews(f: { batchId?: string; all?: boolean }): number {
  const file = reviewsFile()
  let all: JevReviewRecord[] = []
  try {
    all = readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as unknown
          return isRecord(parsed) ? parsed : null
        } catch {
          return null
        }
      })
      .filter((r): r is JevReviewRecord => r != null)
  } catch {
    return 0
  }
  const keep = f.all ? [] : f.batchId ? all.filter((r) => r.batchId !== f.batchId) : all
  const deleted = all.length - keep.length
  if (deleted === 0) return 0
  const tmp = `${file}.${process.pid}.tmp`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(tmp, keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length > 0 ? '\n' : ''), 'utf8')
  renameSync(tmp, file)
  return deleted
}
