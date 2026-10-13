#!/usr/bin/env npx tsx
/**
 * 批量创建 270 个 run：
 * - 通用 15 题 × (C0 + C1) × 3 遍 = 90 runs
 * - 法律 21 题 × (C0 + C2) × 3 遍 = 126 runs
 * - 安全 9 题 × (C0 + C3) × 3 遍 = 54 runs
 * 总计 270 runs
 *
 * 所有 run 使用同一个 LLM：openrouter / nvidia/nemotron-3-super-120b-a12b:free
 */

const API_BASE = 'http://localhost:4000'
const PROVIDER_ID = 'openrouter'
const MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'
const REPEAT = 3

interface Task {
  id: string
  domain: string
}

async function getTasks(): Promise<Task[]> {
  const resp = await fetch(`${API_BASE}/api/playground/tasks`)
  const data = await resp.json()
  return data.tasks.map((t: { id: string; domain: string }) => ({ id: t.id, domain: t.domain }))
}

async function createRuns(taskIds: string[], presetId: string): Promise<{ ok: boolean; created?: Array<{ runId: string; taskId: string }>; error?: string }> {
  const resp = await fetch(`${API_BASE}/api/playground/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskIds,
      presetId,
      providerId: PROVIDER_ID,
      model: MODEL,
    }),
  })
  return resp.json()
}

async function main() {
  console.log('获取题目列表...')
  const tasks = await getTasks()
  console.log(`总题数: ${tasks.length}`)

  // 按领域分组
  const general = tasks.filter((t) => t.domain === 'general').map((t) => t.id)
  const legal = tasks.filter((t) => t.domain === 'legal').map((t) => t.id)
  const security = tasks.filter((t) => t.domain === 'security').map((t) => t.id)

  console.log(`通用: ${general.length} 题`)
  console.log(`法律: ${legal.length} 题`)
  console.log(`安全: ${security.length} 题`)

  // 创建 run 的计划
  const plan: Array<{ domain: string; tasks: string[]; preset: string }> = [
    { domain: 'general', tasks: general, preset: 'C0' },
    { domain: 'general', tasks: general, preset: 'C1' },
    { domain: 'legal', tasks: legal, preset: 'C0' },
    { domain: 'legal', tasks: legal, preset: 'C2' },
    { domain: 'security', tasks: security, preset: 'C0' },
    { domain: 'security', tasks: security, preset: 'C3' },
  ]

  let totalCreated = 0
  let totalFailed = 0

  for (const { domain, tasks: taskIds, preset } of plan) {
    console.log(`\n=== ${domain} / ${preset} (${taskIds.length} 题 × ${REPEAT} 遍 = ${taskIds.length * REPEAT} runs) ===`)

    // 每批最多 50 个 taskIds
    const batchSize = 50
    for (let i = 0; i < taskIds.length; i += batchSize) {
      const batch = taskIds.slice(i, i + batchSize)
      // 每道题重复 REPEAT 次
      const repeatedBatch = batch.flatMap((id) => Array(REPEAT).fill(id))
      
      console.log(`  批次 ${Math.floor(i / batchSize) + 1}: ${batch.length} 题 → ${repeatedBatch.length} runs...`)
      
      try {
        const result = await createRuns(repeatedBatch, preset)
        if (result.ok && result.created) {
          console.log(`  ✓ 创建成功: ${result.created.length} runs`)
          totalCreated += result.created.length
        } else {
          console.error(`  ✗ 创建失败: ${result.error}`)
          totalFailed += repeatedBatch.length
        }
      } catch (err) {
        console.error(`  ✗ 请求异常: ${err}`)
        totalFailed += repeatedBatch.length
      }

      // 批次间稍微停顿，避免打爆服务器
      await new Promise((r) => setTimeout(r, 500))
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(`总计: 创建成功 ${totalCreated} runs, 失败 ${totalFailed} runs`)
  console.log(`预期: 270 runs`)
  console.log('='.repeat(60))
}

main().catch((err) => {
  console.error('脚本执行失败:', err)
  process.exit(1)
})

// Module marker: without it this file is a global script, so its top-level
// consts collide with the other script and tsc reports "Cannot redeclare".
export {}
