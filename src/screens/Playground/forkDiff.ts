// PRD F2-7「同任务双配置逐步轨迹分叉 diff（反事实回放）」的实现件。
//
//   交互：选两个配置，左右对齐逐步回放同一条任务；相同步骤对齐、首次出现差异处
//         高亮为「分叉点」并展开两侧 Thought / Tool / Observation 差异；分叉点
//         之后允许逐步对比两条路径如何走向不同终局。
//   AC：  ② 分叉前步骤一一对齐、首个差异步被明确标出
//         ③ 差异高亮到字段级（调用工具不同 / 观测不同 / 裁决不同），不只是终局分数不同
//
// 这块面板此前做错的三件事，都在这里纠正：
//
//  1. 它把模型 Thought 文本当主信号并排贴出来。PRD 要的是字段级差异——调用工具
//     不同 / 观测不同 / 裁决不同。thought 只作为差异字段之一参与比对，不是版面主角。
//  2. 它只在小标题写一句「First divergence: step N」，不标出是哪一步、也不说差在
//     哪个字段。这里把首个差异步标成 `fork`，并逐字段列出差异。
//  3. 两条轨迹步数不等时，它按位置硬凑行，空的一侧塞 `(no such step)`，一屏噪音。
//     PRD 本来就写了「分叉点之后允许逐步对比两条路径」——分叉之前一一对齐，分叉之后
//     各自走各自的。所以对齐段只到分叉点为止，之后两条路径分开列（各自的步号），
//     「1 步 vs 6 步」这个发现就摆在明面上，而不是靠假行表达。
//
// 字段桶从原始事件现算（不经过 deriveRun 的 marker 集），这样 router.decision 与
// legal.assertion 这两类真实裁决也在内——「裁决不同」是 AC③ 点名的字段。
import type { HarnessEvent } from '../../../shared/events'

/** AC③ 点名的差异字段。顺序即显示顺序。 */
export const FORK_FIELDS = ['thought', 'tool', 'observation', 'decision', 'tag'] as const
export type ForkField = (typeof FORK_FIELDS)[number]

export const FORK_FIELD_LABEL: Record<ForkField, string> = {
  thought: 'Thought',
  tool: 'Tool',
  observation: 'Observation',
  decision: 'Decision',
  tag: 'Failure tag',
}

/** 一个步骤在四个字段上的取值（PRD 的 Thought / Tool / Observation + 裁决 + 失败标签）。 */
export interface StepFields {
  thought: string
  tools: string[]
  observations: string[]
  decisions: string[]
  tags: string[]
}

function emptyFields(): StepFields {
  return { thought: '', tools: [], observations: [], decisions: [], tags: [] }
}

function fieldOf(f: StepFields, k: ForkField): string {
  if (k === 'thought') return f.thought
  const list = k === 'tool' ? f.tools : k === 'observation' ? f.observations : k === 'decision' ? f.decisions : f.tags
  return list.join('\n')
}

/** 事件流 → 步号 → 字段桶。步号缺字段就是空，不是「未知」。 */
export function stepFields(events: HarnessEvent[]): Map<number, StepFields> {
  const out = new Map<number, StepFields>()
  const at = (n: number): StepFields => {
    const cur = out.get(n)
    if (cur) return cur
    const made = emptyFields()
    out.set(n, made)
    return made
  }
  for (const e of events) {
    if (!('step' in e)) continue
    const f = at(e.step)
    switch (e.type) {
      case 'model.response':
        f.thought = f.thought ? `${f.thought}\n${e.thought}` : e.thought
        break
      case 'tool.call':
        f.tools.push(`${e.tool}${e.argsSummary ? ` ${e.argsSummary}` : ''}`)
        break
      case 'tool.result':
        f.observations.push(`${e.tool}: ${e.summary}`)
        break
      case 'failure.tag':
        f.tags.push(`${e.mast} (${Math.round(e.confidence * 100)}%)`)
        break
      // 裁决类：harness 自己在这一步做了什么决定，与模型说什么无关。
      case 'hook.decision':
        f.decisions.push(`hook ${e.hook}: ${e.verdict} — ${e.reason}`)
        break
      case 'permission.request':
        f.decisions.push(`permission requested: ${e.scope} (${e.riskLevel})`)
        break
      case 'permission.granted':
        f.decisions.push(`permission granted: ${e.scope} via ${e.via}`)
        break
      case 'permission.denied':
        f.decisions.push(`permission DENIED: ${e.scope} @ ${e.gate} — ${e.reason}`)
        break
      case 'router.decision':
        f.decisions.push(`router: ${e.tool} → ${e.route} (${e.matchedRule})`)
        break
      case 'verifier.verdict':
        f.decisions.push(`verifier ${e.verifier}: ${e.verdict} — ${e.reason}`)
        break
      case 'sensor.lint':
        f.decisions.push(`lint ${e.lint}: ${e.verdict} — ${e.reason}`)
        break
      case 'legal.assertion':
        f.decisions.push(`legal assertion: ${e.citedAuthority} → ${e.label}`)
        break
      case 'agent.fork':
        f.decisions.push(`fork ${e.childId}: ${e.purpose}`)
        break
      case 'agent.join':
        f.decisions.push(`join ${e.childId}: ${e.summary}`)
        break
      case 'shaper.fire':
        f.decisions.push(`${e.shaper} freed ${e.freedTokens} tok`)
        break
      case 'optimizer.fire':
        f.decisions.push(`optimizer ${e.component}: ${e.action}`)
        break
      case 'compact.boundary':
        f.decisions.push(`compact ${e.strategy}: ${e.beforeTokens} → ${e.afterTokens} tok`)
        break
      default:
        break
    }
  }
  return out
}

export interface ForkRow {
  /** 步号（两侧同号对齐）。 */
  n: number
  a: StepFields
  b: StepFields
  /** 本步取值不同的字段（AC③）。空数组＝两侧一致。 */
  diff: ForkField[]
  /** 首个差异步＝分叉点。 */
  fork: boolean
}

/** 分叉点之后各自独立走的一条路径，带自己的步号。 */
export interface TailStep {
  n: number
  fields: StepFields
}

export interface ForkDiff {
  /** 分叉点之前（含分叉点）的一一对齐行。 */
  rows: ForkRow[]
  /** 首个差异步的步号；全程一致时为 null。 */
  forkAt: number | null
  /** 分叉点之后 A 侧剩下的步骤（可能为空）。 */
  tailA: TailStep[]
  /** 分叉点之后 B 侧剩下的步骤（可能为空）。 */
  tailB: TailStep[]
  /** 两侧各自的步数，用于把「1 步 vs 6 步」这个差异摆出来。 */
  stepsA: number
  stepsB: number
  /** 一侧完全没有事件流时为 true——不拿空轨迹凑对齐（design §15.4 P1 诚实态）。 */
  emptyA: boolean
  emptyB: boolean
  /** 两条路径连一个同号步骤都没有：没有可对齐的前缀，整段分开列。 */
  noCommonPrefix: boolean
}

const sameFields = (a: StepFields, b: StepFields): ForkField[] =>
  FORK_FIELDS.filter((k) => fieldOf(a, k) !== fieldOf(b, k))

/**
 * 两条同任务轨迹的分叉 diff。
 *
 * 分叉点之前（含分叉点）逐行对齐并逐字段比差异；分叉点之后两条路径步数可以不同，
 * 各自按自己的步号列出，不再按位置硬凑。
 */
export function buildForkDiff(aEvents: HarnessEvent[], bEvents: HarnessEvent[]): ForkDiff {
  const fa = stepFields(aEvents)
  const fb = stepFields(bEvents)
  const numsA = [...fa.keys()].sort((x, y) => x - y)
  const numsB = [...fb.keys()].sort((x, y) => x - y)
  const common = numsA.filter((n) => fb.has(n))

  let forkAt: number | null = null
  const marked: ForkRow[] = []
  for (const n of common) {
    const a = fa.get(n)!
    const b = fb.get(n)!
    // 两侧都没有 thought 时 thought 的空值不是差异（否则每步都被判为「想得不一样」）。
    const diff = sameFields(a, b).filter((k) => !(k === 'thought' && !a.thought && !b.thought))
    if (forkAt == null && diff.length > 0) forkAt = n
    marked.push({ n, a, b, diff, fork: false })
  }

  // 对齐段到哪里为止：
  //   有分叉点 → 到分叉点（含）；之后各自走各自的。
  //   全程一致 → 全部对齐，没有尾段。
  //   连一个同号步骤都没有 → 整段都是尾段，一行都不对齐。
  const noCommonPrefix = common.length === 0
  const cut = noCommonPrefix ? Number.NEGATIVE_INFINITY : (forkAt ?? Number.POSITIVE_INFINITY)
  const rows = marked.filter((r) => r.n <= cut)
  if (forkAt != null) {
    const row = rows.find((r) => r.n === forkAt)
    if (row) row.fork = true
  }
  const tail = (nums: number[], src: Map<number, StepFields>): TailStep[] =>
    nums.filter((n) => n > cut).map((n) => ({ n, fields: src.get(n)! }))

  return {
    rows,
    forkAt: noCommonPrefix ? null : forkAt,
    tailA: tail(numsA, fa),
    tailB: tail(numsB, fb),
    stepsA: numsA.length,
    stepsB: numsB.length,
    emptyA: aEvents.length === 0,
    emptyB: bEvents.length === 0,
    noCommonPrefix,
  }
}