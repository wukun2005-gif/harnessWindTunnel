// Every DSL field a preset sets must actually change what the run does.
//
// Why this file exists: C1's only knob was `filesystem=file-backed-state`, and
// the runner never read it — so C0 and C1 executed the same code path and any
// score difference between them was pure sampling noise. The same was true of
// C3's `sandbox` and C2's `observability`. These tests drive a real run and
// assert the config changed the prompt, the tool surface, or the gate.
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_CONFIG, CONFIG_FIELDS } from '../shared/config'
import type { ChatRequest, ChatResponse, ResolvedTarget } from '../server/playground/llmClient'
import type { McpCallResult } from '../server/playground/patentLawMcp'
import type { EvalTask, PgPreset } from '../shared/playground'
import type { HarnessEvent } from '../shared/events'

// liveDb / settingsStore freeze their paths at module load, so the env must be
// set before the dynamic import (same pattern as playground-e2e.test.ts).
const dir = mkdtempSync(join(tmpdir(), 'hwt-harness-'))
process.env['HWT_SETTINGS_FILE'] = join(dir, 'settings.json')
process.env['HWT_PLAYGROUND_DB'] = join(dir, 'playground.db')
writeFileSync(
  process.env['HWT_SETTINGS_FILE']!,
  JSON.stringify({
    provider_all: {
      providers: [{ providerId: 'chat-a', baseUrl: 'https://chat-a.test/v1', apiKeyRef: 'k-a', defaultModelId: 'chat-a-1', enabled: true }],
    },
  }),
)

let createRun!: typeof import('../server/playground/runner')['createRun']
let executeRun!: typeof import('../server/playground/runner')['executeRun']
let getRunDetail!: typeof import('../server/playground/liveDb')['getRunDetail']
let PG_PRESETS!: PgPreset[]
let getTask!: typeof import('../server/playground/evalset')['getTask']
let task!: EvalTask

before(async () => {
  const runner = await import('../server/playground/runner')
  const db = await import('../server/playground/liveDb')
  const presets = await import('../server/playground/presets')
  const evalset = await import('../server/playground/evalset')
  createRun = runner.createRun
  executeRun = runner.executeRun
  getRunDetail = db.getRunDetail
  PG_PRESETS = presets.PG_PRESETS
  getTask = evalset.getTask
  task = evalset.getTask('G1')!
})

type Script = Array<{ text?: string; tool?: { name: string; args: Record<string, unknown> } }>

/** A chat dependency that replays `script` and records every request it saw. */
function fakeChat(script: Script, seen: ChatRequest[]): (t: ResolvedTarget, r: ChatRequest) => Promise<ChatResponse> {
  let i = 0
  return async (_t, req) => {
    seen.push(req)
    const step = script[Math.min(i, script.length - 1)]!
    i++
    return {
      text: step.text ?? '',
      toolCalls: step.tool ? [{ id: `c${i}`, name: step.tool.name, arguments: step.tool.args }] : [],
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      stopReason: step.tool ? 'tool_calls' : 'stop',
    }
  }
}

const ANSWER = '本案涉及一种基于相变材料的LED散热模组，申请人为深圳光明科技有限公司，申请号202410567890.1。第一次审查意见通知书提出三项驳回理由：新颖性、创造性、清楚性。卷宗内申请号编号不一致。'

interface RunOutcome {
  events: HarnessEvent[]
  seen: ChatRequest[]
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>
}

async function run(presetId: string, script: Script, taskId = 'G1'): Promise<RunOutcome> {
  const preset = PG_PRESETS.find((p) => p.id === presetId)!
  const made = createRun({
    task: getTask(taskId)!,
    config: preset.config,
    mounts: preset.mounts,
    presetId: preset.id as PgPreset['id'],
    providerId: 'chat-a',
    model: 'chat-a-1',
  })
  assert.ok(!('error' in made), `createRun failed: ${'error' in made ? made.error : ''}`)
  const seen: ChatRequest[] = []
  const toolCalls: RunOutcome['toolCalls'] = []
  await executeRun(made.runId, {
    chat: fakeChat(script, seen),
    callTool: async (name, args): Promise<McpCallResult> => {
      toolCalls.push({ name, args })
      return { ok: true, tool: name, summary: 'stub', data: { ok: true } }
    },
  })
  const detail = getRunDetail(made.runId)!
  return { events: detail.events, seen, toolCalls }
}

const userText = (req: ChatRequest): string =>
  req.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n')

const systemText = (req: ChatRequest): string =>
  req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')

// ── filesystem=file-backed-state (C1) ────────────────────────────────────────

test('file-backed state hands the dossier over as files instead of pasting it in', async () => {
  const backed = await run('C1', [{ text: ANSWER }])
  const baseline = await run('C0', [{ text: ANSWER }])

  // The baseline still inlines the dossier...
  assert.match(userText(baseline.seen[0]!), /【卷宗文件】申请文件\.pdf/, 'C0 inlines the dossier')
  // ...C1 does not: the model gets a manifest and has to open the files.
  assert.doesNotMatch(userText(backed.seen[0]!), /【卷宗文件】/, 'C1 must not inline the dossier')
  assert.match(userText(backed.seen[0]!), /dossier\/申请文件\.pdf/, 'C1 advertises a file manifest')
  assert.ok(
    userText(backed.seen[0]!).length * 4 < userText(baseline.seen[0]!).length,
    'the manifest must be dramatically smaller than the dossier it replaces',
  )
})

test('file-backed state mounts the file tools; the baseline mounts none', async () => {
  const backed = await run('C1', [{ text: ANSWER }])
  const baseline = await run('C0', [{ text: ANSWER }])
  const names = (r: ChatRequest): string[] => (r.tools ?? []).map((t) => t.function.name)

  assert.deepEqual(names(backed.seen[0]!).sort(), ['fs_list', 'fs_read', 'fs_write'])
  assert.deepEqual(names(baseline.seen[0]!), [], 'C0 must not offer a workspace it does not have')
})

test('a file read is a real tool call, and the content reaches the model', async () => {
  const out = await run('C1', [
    { tool: { name: 'fs_read', args: { path: 'dossier/申请文件.pdf' } } },
    { text: ANSWER },
  ])
  const call = out.events.find((e) => e.type === 'tool.call')
  assert.ok(call && call.type === 'tool.call' && call.tool === 'fs_read', 'fs_read must be emitted as a tool call')
  // Second request carries the file contents back.
  const second = out.seen[1]!
  assert.ok(second.messages.some((m) => m.role === 'tool' && m.content.includes('相变材料')), 'file contents must reach the model')
})

// ── sandbox (C3) ─────────────────────────────────────────────────────────────

test('write-barrier refuses a write before it executes', async () => {
  const out = await run('C3', [
    { tool: { name: 'fs_write', args: { path: 'notes.md', content: 'x' } } },
    { text: ANSWER },
  ])
  const route = out.events.find((e) => e.type === 'router.decision' && e.tool === 'fs_write')
  assert.ok(route && route.type === 'router.decision')
  assert.equal(route.route, 'REFUSE')
  assert.equal(route.matchedRule, 'sandbox-write-barrier')

  const denied = out.events.find((e) => e.type === 'permission.denied')
  assert.ok(denied && denied.type === 'permission.denied', 'a denied write must be recorded as permission.denied')
  assert.equal(denied.gate, 'sandbox')

  assert.equal(out.toolCalls.length, 0, 'the write must not reach the tool implementation')
})

test('with the sandbox off the same write is allowed', async () => {
  // C1 has a workspace (file-backed) and sandbox=off, so it can host the allow path.
  const out = await run('C1', [
    { tool: { name: 'fs_write', args: { path: 'notes.md', content: 'x' } } },
    { text: ANSWER },
  ])
  const route = out.events.find((e) => e.type === 'router.decision' && e.tool === 'fs_write')
  assert.ok(route && route.type === 'router.decision')
  assert.equal(route.route, 'EXECUTE')
  assert.equal(route.matchedRule, 'sandbox-off-write-allowed')
  assert.equal(out.events.filter((e) => e.type === 'permission.denied').length, 0)
})

test('reads are never barred, whatever the sandbox says', async () => {
  const out = await run('C3', [
    { tool: { name: 'fs_read', args: { path: 'nothing.md' } } },
    { text: ANSWER },
  ])
  const route = out.events.find((e) => e.type === 'router.decision' && e.tool === 'fs_read')
  assert.ok(route && route.type === 'router.decision')
  assert.equal(route.route, 'EXECUTE')
})

// ── observability (C2) ───────────────────────────────────────────────────────

test('trace records what reached the model; off records only the shape', async () => {
  const traced = await run('C2', [{ text: ANSWER }])
  const plain = await run('C0', [{ text: ANSWER }])
  const blocks = (events: HarnessEvent[]): Array<{ preview?: string }> => {
    const req = events.find((e) => e.type === 'model.request')
    assert.ok(req && req.type === 'model.request')
    return req.blocks
  }
  assert.ok(blocks(traced.events).every((b) => typeof b.preview === 'string'), 'trace must attach a preview to every block')
  assert.ok(blocks(plain.events).every((b) => b.preview === undefined), 'off must not attach previews')
})

// ── permissions=deny-first (C3) ──────────────────────────────────────────────
//
// The gate only has something to refuse when the question actually overreaches, so
// this runs on S2 — the one that demands the deliberation record. On a question that
// asks for nothing improper the same preset must stay silent, which the second test
// pins: "armed" is not "fired", and a gate that refuses everything would be a
// different bug.

test('deny-first refuses a request for non-public case material, at step 0', async () => {
  const out = await run('C3', [{ text: ANSWER }], 'S2')
  const route = out.events.find((e) => e.type === 'router.decision' && e.matchedRule === 'deny-nonpublic-case-materials')
  assert.ok(route && route.type === 'router.decision', 'the overreaching request must hit the permission router')
  assert.equal(route.route, 'REFUSE')
  assert.equal(route.step, 0)

  const denied = out.events.find((e) => e.type === 'permission.denied')
  assert.ok(denied && denied.type === 'permission.denied')
  assert.equal(denied.gate, 'permission-gate')
  // The refusal has to reach the model, otherwise it is only a log line.
  assert.match(systemText(out.seen[0]!), /权限门裁决/)
})

test('with permissions open the same request is not gated', async () => {
  const out = await run('C0', [{ text: ANSWER }], 'S2')
  assert.equal(out.events.filter((e) => e.type === 'router.decision' && e.matchedRule === 'deny-nonpublic-case-materials').length, 0)
  assert.equal(out.events.filter((e) => e.type === 'permission.denied').length, 0)
})

// ── globalPolicy=policy-enforced (C3) ────────────────────────────────────────

test('egress DLP catches a leaked id number and makes the model rewrite', async () => {
  // S3 carries a real id-card pattern; the first answer leaks it verbatim.
  const leaky = '要素表：代理人陈思远，身份证号 110101199003071234，退费账号 6222021234567890123。'
  const clean = '要素表：代理人陈思远，身份证号 110***********1234，退费账号 6222***********0123。'
  const out = await run('C3', [{ text: leaky }, { text: clean }], 'S3')

  const denied = out.events.find((e) => e.type === 'hook.decision' && e.hook === 'egress-dlp' && e.verdict === 'deny')
  assert.ok(denied && denied.type === 'hook.decision', 'a leak must be denied at the egress gate')
  const rewrite = out.events.find((e) => e.type === 'hook.decision' && e.hook === 'egress-dlp' && e.verdict === 'rewrite')
  assert.ok(rewrite && rewrite.type === 'hook.decision', 'a successful rewrite must be recorded as such')
  assert.ok(out.seen.length >= 2, 'the blocked answer must be sent back for a rewrite')
})

test('with globalPolicy off the same leak goes out unblocked', async () => {
  const leaky = '要素表：代理人陈思远，身份证号 110101199003071234。'
  const out = await run('C0', [{ text: leaky }], 'S3')
  assert.equal(out.events.filter((e) => e.type === 'hook.decision' && e.hook === 'egress-dlp').length, 0)
})

// ── hooks=lifecycle (C3) ─────────────────────────────────────────────────────

test('lifecycle hooks wrap an untrusted dossier, and the wrapper is stated in the prompt', async () => {
  const out = await run('C3', [{ text: ANSWER }], 'G1')
  const hook = out.events.find((e) => e.type === 'hook.decision' && e.hook === 'untrusted-input-wrap')
  assert.ok(hook && hook.type === 'hook.decision', 'a dossier-bearing question must trip the input-isolation hook')
  assert.match(userText(out.seen[0]!), /不可信输入数据/)
})

test('with hooks off the dossier goes in unwrapped', async () => {
  const out = await run('C0', [{ text: ANSWER }], 'G1')
  assert.equal(out.events.filter((e) => e.type === 'hook.decision' && e.hook === 'untrusted-input-wrap').length, 0)
  assert.doesNotMatch(userText(out.seen[0]!), /不可信输入数据/)
})

// ── sensors=verifier + mount (C2) ────────────────────────────────────────────

test('sensors=verifier audits citations and records a verdict', async () => {
  // L1 has expectedArticles, so the verifier has something to check.
  const out = await run('C2', [{ text: ANSWER }], 'L1')
  assert.ok(
    out.events.some((e) => e.type === 'verifier.verdict'),
    'the citation sensor must always record a verdict when it is on',
  )
})

test('with sensors off no verdict is recorded', async () => {
  const out = await run('C0', [{ text: ANSWER }], 'L1')
  assert.equal(out.events.filter((e) => e.type === 'verifier.verdict').length, 0)
  assert.equal(out.events.filter((e) => e.type === 'legal.assertion').length, 0)
})

test('the mounted authority MCP is offered to the model', async () => {
  const out = await run('C2', [{ text: ANSWER }], 'L1')
  const names = (out.seen[0]!.tools ?? []).map((t) => t.function.name)
  assert.ok(names.some((n) => n.startsWith('patent_law_')), `expected patent_law_* tools, got ${names.join(',')}`)
  const baseline = await run('C0', [{ text: ANSWER }], 'L1')
  assert.deepEqual(baseline.seen[0]!.tools ?? [], [], 'C0 mounts nothing')
})

// ── the regression guard for the whole class of bug ──────────────────────────

test('every DSL field a preset sets away from its default is read by the runner', () => {
  // The bug this pins: a preset set a field, the field fed the control snapshot,
  // and the runner never read it — so the config was a label, not a treatment.
  const src = readFileSync('server/playground/runner.ts', 'utf8')
  const consumed = new Set([...src.matchAll(/config\.([a-zA-Z]+)/g)].map((m) => m[1]))
  const inert: string[] = []
  for (const preset of PG_PRESETS) {
    for (const field of CONFIG_FIELDS) {
      const value = preset.config[field]
      if (value === BASE_CONFIG[field]) continue
      if (!consumed.has(field)) inert.push(`${preset.id}.${field}=${value}`)
    }
  }
  assert.deepEqual(inert, [], `these knobs change nothing in a run: ${inert.join(', ')}`)
})

// ── tool-round budget (the C1/G1 "answered nothing" run) ─────────────────────
//
// File-backed state changes the shape of the task: the dossier is not in the prompt,
// so every file costs a round to find and open. G1 has five of them, and six rounds
// was exactly enough to list and read all five — leaving nothing for the answer. The
// run was recorded as a total miss having read everything it needed.

test('file-backed state gets a round per dossier file on top of the base budget', async () => {
  const files = getTask('G1')!.dossierFiles!.length
  assert.ok(files > 0, 'this test needs a question with a dossier')
  const script: Script = [{ tool: { name: 'fs_list', args: {} } }]

  const backed = await run('C1', script)
  const baseline = await run('C0', script)
  const rounds = (o: RunOutcome): number => o.events.filter((e) => e.type === 'model.request').length

  assert.equal(rounds(baseline), 7, 'base budget 6 + the forced answer turn')
  assert.equal(rounds(backed), 6 + files + 1, 'one round per file, then the forced answer turn')
})

test('a model that only calls tools still gets a forced answer turn, and it is used', async () => {
  const files = getTask('G1')!.dossierFiles!.length
  const FINAL = '案情摘要：本案技术主题为基于相变材料的LED散热模组，申请人为深圳光明科技有限公司。'
  // Every round returns a tool call; only the forced turn returns prose.
  const script: Script = Array.from({ length: 6 + files }, () => ({ tool: { name: 'fs_list', args: {} } }))
  script.push({ text: FINAL })

  const out = await run('C1', script)
  const last = out.seen[out.seen.length - 1]!
  assert.equal(last.tools, undefined, 'the forced turn must take the tools away')
  assert.match(
    last.messages.map((m) => m.content).join('\n'),
    /不得再请求任何工具/,
    'the forced turn must say why no tools are offered',
  )
  assert.equal(
    out.events.some((e) => e.type === 'hook.decision' && e.hook === 'empty-answer'),
    false,
    'an answer was produced, so nothing may be recorded as empty',
  )
})

test('if even the forced turn yields no prose, the placeholder says so', async () => {
  const out = await run('C1', [{ tool: { name: 'fs_list', args: {} } }])
  const empty = out.events.find((e) => e.type === 'hook.decision' && e.hook === 'empty-answer')
  assert.ok(empty, 'the empty-answer record must still exist when nothing was produced')
  const detail = getRunDetail(
    (out.events[0] as Extract<HarnessEvent, { type: 'run.started' }>).runId,
  )
  assert.match(detail?.answer ?? '', /已追加一次强制答复轮/, 'the reason must not blame the round cap alone')
})
