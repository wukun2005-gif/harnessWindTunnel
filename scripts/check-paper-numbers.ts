/* eslint-disable no-console */
// 预设读数 vs 论文对照表校验（防「mock 冒充实测」）。CI/演示前必跑。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fingerprint } from '../shared/config'
import type { MetricsEntry, ScenarioMeta } from '../shared/events'

const DATA = resolve(import.meta.dirname, '..', 'data')
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const meta = (id: string) => read(resolve(DATA, 'scenarios', id, 'meta.json')) as ScenarioMeta
const mOf = (id: string, branchId: string): MetricsEntry => {
  const m = meta(id)
  const b = m.branches.find((x) => x.branchId === branchId)
  if (!b) throw new Error(`branch ${branchId} 不存在于 ${id}`)
  const e = m.metrics[b.fingerprint]
  if (!e) throw new Error(`${id}/${branchId} 缺 metrics`)
  return e
}

type Check = { name: string; ok: boolean; detail: string }
const checks: Check[] = []
const ck = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail })
const near = (a: number, b: number, eps = 0.051) => Math.abs(a - b) <= eps

// ===== NLAH 消融（workflow 场景，OSWorld 族）=====
{
  const base = mOf('workflow-crm-export', 'base').successRate
  ck('NLAH 基线 46.2（示意）', near(base, 46.2), `base = ${base}`)
  const ver = mOf('workflow-crm-export', 'verifier').successRate
  ck('NLAH Verifier Δ = −8.4pp', near(ver - base, -8.4), `${base} → ${ver} = ${ver - base}`)
  const fs = mOf('workflow-crm-export', 'filestate').successRate
  ck('NLAH File-backed State Δ = +5.5pp', near(fs - base, 5.5), `${base} → ${fs} = ${fs - base}`)
  const mc = mOf('workflow-crm-export', 'multicand').successRate
  ck('NLAH Multi-Candidate Δ = −3.1pp（示意）', near(mc - base, -3.1), `${base} → ${mc} = ${mc - base}`)
}

// ===== NLAH coding 族：Self-Evolution +4.8 =====
{
  const base = mOf('coding-terminal-refactor', 'base').successRate
  const se = mOf('coding-terminal-refactor', 'selfevo').successRate
  ck('NLAH Self-Evolution（SWE 族）Δ = +4.8pp', near(se - base, 4.8), `${base} → ${se} = ${se - base}`)
}

// ===== AHE 十代 69.7 → 77.0 =====
{
  const g0 = mOf('coding-terminal-refactor', 'ahe-gen0').successRate
  const g10 = mOf('coding-terminal-refactor', 'tuned').successRate
  ck('AHE 起点 69.7', near(g0, 69.7), `ahe-gen0 = ${g0}`)
  ck('AHE 终点 77.0', near(g10, 77.0), `tuned = ${g10}`)
}

// ===== Harness-R1：41.6 → 35.4（−6.2pp）=====
{
  const b = mOf('coding-terminal-refactor', 'r1-batch').successRate
  const n = mOf('coding-terminal-refactor', 'r1-naive').successRate
  ck('Harness-R1 基线 41.6', near(b, 41.6), `r1-batch = ${b}`)
  ck('Harness-R1 naive 补丁 35.4（−6.2pp）', near(n - b, -6.2), `${b} → ${n} = ${n - b}`)
}

// ===== Forge 曲线：69.7 + Σapproved gains = 77.0 =====
{
  const forge = read(resolve(DATA, 'forge', 'generations.json'))
  const sum = (forge.gens as { gain: number; verdict: string }[]).filter((g) => g.verdict === 'approved').reduce((a, g) => a + g.gain, 0)
  ck('Forge 十代增益合计 = 7.3pp（69.7→77.0）', near(forge.startScore + sum, forge.endScore), `69.7 + ${sum.toFixed(1)} = ${(forge.startScore + sum).toFixed(1)} vs ${forge.endScore}`)
  const hasRejected = (forge.gens as { verdict: string }[]).some((g) => g.verdict === 'rejected')
  ck('Forge 含「越改越差」被拒反例（Gen6）', hasRejected, 'Harness-R1 反例必须留在剧本里')
}

// ===== 演示开场：base 34 / tuned 77 =====
{
  const base = mOf('coding-terminal-refactor', 'base').successRate
  const tuned = mOf('coding-terminal-refactor', 'tuned').successRate
  ck('开场 34 vs 77（标注示意/论文）', near(base, 34) && near(tuned, 77), `${base} vs ${tuned}`)
}

// ===== 预设 ↔ 分支一致性：preset variant.branchId 必须命中且指纹一致 =====
{
  const presets = (await import('../shared/presets')).PRESETS
  for (const p of presets) {
    for (const v of p.variants) {
      if (!v.branchId) continue
      const m = meta(p.scenarioId)
      const b = m.branches.find((x) => x.branchId === v.branchId)
      if (!b) { ck(`预设 ${p.id}·${v.label} 分支存在`, false, `${v.branchId} 不存在`); continue }
      ck(`预设 ${p.id}·${v.label} 配置=分支配置`, b.fingerprint === fingerprint(v.config), `preset fp ${fingerprint(v.config)} vs branch fp ${b.fingerprint}`)
    }
  }
}

// ===== 诚实原则：论文数字必须挂 paper-reproduction 来源 =====
{
  const ids: [string, string][] = [
    ['coding-terminal-refactor', 'tuned'], ['coding-terminal-refactor', 'ahe-gen0'],
    ['coding-terminal-refactor', 'r1-batch'], ['coding-terminal-refactor', 'r1-naive'],
    ['workflow-crm-export', 'filestate'],
  ]
  for (const [s, b] of ids) {
    const e = mOf(s, b)
    ck(`${s}/${b} 来源=论文复现`, e.source.kind === 'paper-reproduction', e.source.kind)
  }
  const plain = mOf('coding-terminal-refactor', 'base')
  ck('coding/base 来源=fixture（不冒充论文）', plain.source.kind === 'fixture', plain.source.kind)
}

let fail = 0
for (const c of checks) {
  console.log(`${c.ok ? '✅' : '❌'} ${c.name}  —  ${c.detail}`)
  if (!c.ok) fail++
}
console.log(`\n${checks.length - fail}/${checks.length} passed`)
process.exit(fail ? 1 : 0)
