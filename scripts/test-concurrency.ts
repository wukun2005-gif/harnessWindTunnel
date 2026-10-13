#!/usr/bin/env npx tsx
/**
 * 测试 openrouter 免费模型的并发能力
 * 逐步增加并发数，观察是否被 rate limit
 */

const API_BASE = 'http://localhost:4000'
const PROVIDER_ID = 'openrouter'
const MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'

async function testConcurrency(concurrency: number): Promise<{ ok: boolean; results: Array<{ ok: boolean; error?: string; status?: number }> }> {
  console.log(`\n=== 测试并发 ${concurrency} ===`)
  
  const tasks = Array.from({ length: concurrency }, (_, i) => i)
  const results: Array<{ ok: boolean; error?: string; status?: number }> = []

  // 先创建 run
  const runIds: string[] = []
  for (const i of tasks) {
    const resp = await fetch(`${API_BASE}/api/playground/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskIds: ['G1'], // 用最简单的题测试
        presetId: 'C0',
        providerId: PROVIDER_ID,
        model: MODEL,
      }),
    })
    const data = await resp.json()
    if (data.ok && data.created?.[0]?.runId) {
      runIds.push(data.created[0].runId)
    } else {
      console.log(`  创建 run ${i} 失败: ${data.error || 'unknown'}`)
      return { ok: false, results: [] }
    }
  }
  
  console.log(`  已创建 ${runIds.length} 个 run，等待执行...`)

  // 等待一会儿，观察是否被 rate limit
  await new Promise((r) => setTimeout(r, 10000))

  // 检查 run 状态
  for (const runId of runIds) {
    const resp = await fetch(`${API_BASE}/api/playground/runs/${runId}`)
    const data = await resp.json()
    const status = data.status
    const error = data.error
    const isRateLimited = error?.includes('429') || error?.includes('rate limit') || error?.includes('Rate limit')
    
    results.push({
      ok: status === 'scored' || status === 'running' || status === 'queued',
      error: error || undefined,
      status: isRateLimited ? 429 : undefined,
    })
    
    if (isRateLimited) {
      console.log(`  ✗ Run ${runId}: RATE LIMITED - ${error}`)
    } else if (status === 'error') {
      console.log(`  ✗ Run ${runId}: error - ${error}`)
    } else {
      console.log(`  ✓ Run ${runId}: ${status}`)
    }
  }

  const rateLimited = results.filter((r) => r.status === 429 || r.error?.includes('429')).length
  const success = results.filter((r) => r.ok).length
  
  console.log(`  结果: ${success}/${results.length} 正常, ${rateLimited} rate limited`)
  
  return { ok: rateLimited === 0, results }
}

async function main() {
  console.log('测试 openrouter 免费模型并发能力')
  console.log(`模型: ${MODEL}`)
  
  // 测试并发 2
  const result2 = await testConcurrency(2)
  if (!result2.ok) {
    console.log('\n并发 2 就被 rate limit 了，需要降低并发')
    return
  }
  
  // 等一会儿再测并发 3
  await new Promise((r) => setTimeout(r, 30000))
  const result3 = await testConcurrency(3)
  if (!result3.ok) {
    console.log('\n并发 3 被 rate limit，安全并发数为 2')
    return
  }
  
  // 等一会儿再测并发 4
  await new Promise((r) => setTimeout(r, 30000))
  const result4 = await testConcurrency(4)
  if (!result4.ok) {
    console.log('\n并发 4 被 rate limit，安全并发数为 3')
    return
  }
  
  console.log('\n并发 4 也正常，可以尝试更高并发')
}

main().catch((err) => {
  console.error('测试失败:', err)
  process.exit(1)
})

// Module marker: without it this file is a global script, so its top-level
// consts collide with the other script and tsc reports "Cannot redeclare".
export {}
