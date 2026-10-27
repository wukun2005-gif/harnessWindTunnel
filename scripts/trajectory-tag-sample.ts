// P2 step 8 — sample a few recorded runs and tag them with the model.
//
// This is the replacement for the human gold batch the plan originally asked
// for (user decision 2026-10-26: no human labelling). Because there is no gold
// set, the script reports two things and nothing more:
//
//   • what the model tagged, with its confidence and the step it pointed at;
//   • whether the deterministic reading of the same run has a hard violation —
//     a cross-check, NOT an accuracy figure. A model tag can never change that
//     boolean, and disagreement here is a prompt to read the trajectory, not to
//     re-tune the contract.
//
// Usage:
//   npx tsx scripts/trajectory-tag-sample.ts                 # 2 runs per pilot task
//   npx tsx scripts/trajectory-tag-sample.ts --task L12 --per-task 3
//   npx tsx scripts/trajectory-tag-sample.ts --dry            # print digests, no model call
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getRunDetail, listRuns } from '../server/playground/liveDb'
import { getLiveContractForTask, verdictFor } from '../server/trajectoryStore'
import { buildTagDigest, tagTrajectory } from '../server/playground/trajectoryTags'

const PILOT = ['G4', 'G11', 'L12', 'L20', 'S2', 'S6']

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback
}

async function main(): Promise<void> {
  const only = arg('task', '')
  const perTask = Number(arg('per-task', '2'))
  const dry = process.argv.includes('--dry')
  const tasks = only ? [only] : PILOT
  const rows: Array<Record<string, unknown>> = []

  for (const taskId of tasks) {
    const contract = getLiveContractForTask(taskId)
    if (!contract) { console.log(`${taskId}: no contract, skipped`); continue }
    // Newest first: a sample is meant to describe the current harness, not the
    // oldest configuration that happens to sit in the DB.
    const runs = listRuns({ taskId, limit: 500 }).slice(0, perTask)
    for (const r of runs) {
      const detail = getRunDetail(r.runId)
      const envelope = verdictFor(r.runId)
      if (!detail || !envelope || detail.events.length === 0) continue
      if (dry) {
        console.log(`\n=== ${taskId} ${r.runId} (${r.configLabel}) — digest only ===`)
        console.log(buildTagDigest({
          taskId, taskTitle: detail.taskTitle, domain: detail.domain, answer: detail.answer,
          events: detail.events, verdict: envelope.verdict,
        }).slice(0, 1200))
        continue
      }
      const out = await tagTrajectory({
        runId: r.runId, taskId, taskTitle: detail.taskTitle, domain: detail.domain,
        answer: detail.answer, events: detail.events, verdict: envelope.verdict,
      })
      if (!out.ok) {
        console.log(`${taskId} ${r.runId}: tagging failed — ${out.error}`)
        continue
      }
      const v = envelope.verdict
      rows.push({
        taskId, runId: r.runId, config: r.configLabel,
        cell: v.cell, hardViolation: v.hardViolation, processIncomplete: v.processIncomplete,
        tags: out.record.tags, summary: out.record.summary, model: out.record.model,
      })
      const tags = out.record.tags.map((t) => `${t.tag}@${t.confidence.toFixed(2)}`).join(', ') || '(none)'
      console.log(`${taskId} ${r.runId} [${v.cell ?? (v.processIncomplete ? 'process-incomplete' : 'unknown')}] hard=${v.hardViolation} → ${tags}`)
    }
  }

  if (dry) return
  const out = resolve('server-data', 'trajectory-tag-sample.json')
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), nonGold: true, rows }, null, 2) + '\n')
  const tagged = rows.filter((r) => (r.tags as unknown[]).length > 0).length
  const hard = rows.filter((r) => r.hardViolation === true).length
  console.log(`\n${rows.length} runs tagged (${tagged} with at least one tag), ${hard} of them carry a hard violation.`)
  console.log('Tags are model output, not gold: they are evidence to read, never a verdict.')
  console.log(`wrote ${out}`)
}

void main()
