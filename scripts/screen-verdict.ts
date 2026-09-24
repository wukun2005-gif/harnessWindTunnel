// 分析页签总建议的权威计算（与 src/screens/Playground/analysis.ts 同一套门限），按批次过滤。
// 用法：npx tsx scripts/screen-verdict.ts <batchId>
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  agreementStats,
  calibrationBuckets,
  calibrationStatus,
  driftStats,
  injectionStats,
  overallVerdict,
  sourceDist,
  costStats,
} from '../src/screens/Playground/analysis'
import type { JevReviewRecord } from '../shared/jev'

const batchId = process.argv[2]
if (!batchId) {
  console.error('usage: screen-verdict.ts <batchId>')
  process.exit(1)
}
const all = readFileSync(resolve(process.cwd(), 'server-data/jev-reviews.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as JevReviewRecord)
const records = all.filter((r) => r.batchId === batchId)
if (!records.length) {
  console.error(`no records for batch ${batchId}`)
  process.exit(1)
}
const agreement = agreementStats(records)
const drift = driftStats(records)
const buckets = calibrationBuckets(records)
const calib = calibrationStatus(buckets)
const injection = injectionStats(records).status
const verdict = overallVerdict({
  total: records.length,
  drift,
  agreement,
  calib,
  trapTotal: 0,
  injection,
})

console.log(`== batch ${batchId} · ${records.length} 条 ==`)
console.log(`一致率: ${agreement.agree}/${agreement.total} = ${agreement.rate == null ? 'n/a' : Math.round(agreement.rate * 1000) / 10}% (不可比 ${agreement.incomparable})`)
console.log(`分歧题: ${agreement.divergentIds.join(',') || '无'}`)
console.log(`漂移: ${drift.drifted}/${drift.samples} = ${drift.rate == null ? 'n/a' : Math.round(drift.rate * 1000) / 10}%`)
console.log('校准桶:')
for (const b of buckets) console.log(`  ${b.lo}-${Math.round(b.hi * 100)}: ${b.agree}/${b.n}${b.rate != null ? ` = ${Math.round(b.rate * 100)}%` : ''}`)
console.log(`校准状态: ${calib}`)
console.log(`注入状态: ${injection}`)
console.log('来源:', JSON.stringify(sourceDist(records)))
const cost = costStats(records)
console.log(`延迟 p50: ${cost.p50} ms`)
console.log(`总建议: ${verdict.state} · reasons=${JSON.stringify(verdict.reasons)}`)
