// M4 LLM change-card generation inside the routed edit surface (PRISM §7.2③).
//
// The LLM never writes an applied config. It only authors natural-language
// wording and, for the middleware surface, chooses values from the legal DSL
// enum. The deterministic router already supplies a safe in-table patch; this
// module enriches it and validates everything. Any off-table combination is
// flagged for human review and can never autoplay.
import { COMPONENT_META, type ConfigField, type HarnessConfig } from '../../shared/config'
import { MAST_LABEL } from '../../shared/mast'
import type {
  ChangeCard,
  EvoCluster,
  EvoSurface,
  PgMounts,
  RunDetail,
} from '../../shared/playground'
import { routeCluster, type RoutingDecision } from './router'
import { appliedSurfacesForCluster, insertCard } from './evoDb'
import { chatCompletion, resolveChatTarget } from './llmClient'

const now = () => new Date().toISOString()
const id = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`

/** Validate a raw LLM middleware patch against the DSL schema and the routed seam. */
export function validateMiddleware(
  raw: Record<string, unknown>,
  routedFields: Set<string>,
): { valid: Partial<HarnessConfig>; inTable: boolean; rejected: string[] } {
  const valid: Partial<HarnessConfig> = {}
  const rejected: string[] = []
  let inTable = true
  for (const [field, value] of Object.entries(raw)) {
    const meta = COMPONENT_META[field as ConfigField]
    if (!meta) {
      rejected.push(`${field}: not a legal DSL field`)
      inTable = false
      continue
    }
    const opt = meta.options.find((o) => o.value === value)
    if (!opt) {
      rejected.push(`${field}=${String(value)}: illegal enum value`)
      continue
    }
    if (!routedFields.has(field)) {
      // A different control than the routed seam: legal value but a new
      // combination → keep for human review, never autoplay.
      inTable = false
    }
    ;(valid as Record<string, unknown>)[field] = value
  }
  return { valid, inTable, rejected }
}

interface Evidence {
  tasks: string[]
  body: string
}

function buildEvidence(cluster: EvoCluster, runs: RunDetail[]): Evidence {
  const sample = runs.filter((r) => cluster.runIds.includes(r.runId)).slice(0, 3)
  const tasks: string[] = []
  const chunks: string[] = []
  for (const r of sample) {
    tasks.push(r.taskId)
    const fact = r.verdict?.factChecks?.filter((f) => f.required && !f.hit)
      .map((f) => `• missing point: ${f.label} (lacks ${f.missingTerms.join('/') || 'key wording'})`).slice(0, 4)
    const art = r.verdict?.articleChecks?.filter((a) => !a.articleExists || a.assertion === 'unsupported' || a.assertion === 'citation_unreachable' || a.assertion === 'no_citation')
      .map((a) => `• statute check failed (${a.law}${a.article ?? ''}): ${a.detail}`).slice(0, 3)
    const sec = r.verdict?.securityChecks?.filter((s) => !s.passed)
      .map((s) => `• security check failed (${s.kind}): ${s.detail}`).slice(0, 3)
    const reasons = [...(fact ?? []), ...(art ?? []), ...(sec ?? [])].join('\n')
    chunks.push(
      `[task ${r.taskId} | ${r.taskTitle}]\n` +
      `failure tags: ${r.failureTags.join(', ') || 'none'}\n` +
      `scoring: ${r.verdict?.summary ?? '(none)'}\n` +
      `${reasons ? `failed checks:\n${reasons}\n` : ''}` +
      `final answer excerpt: ${(r.answer ?? '').slice(0, 300)}`,
    )
  }
  return { tasks, body: chunks.join('\n\n') }
}

function surfaceLabel(s: EvoSurface): string {
  return s === 'prompt' ? 'prompt (guidance text only, no DSL change)'
    : s === 'middleware' ? 'middleware (deterministic DSL controls only)'
      : 'joint (guidance text + one DSL control)'
}

function buildPrompt(
  cluster: EvoCluster,
  route: RoutingDecision,
  evidence: Evidence,
  baseConfig: HarnessConfig,
): string {
  const dslAllowed = route.dsl ? Object.keys(route.dsl) : []
  return [
    'You are an agent-harness self-evolution engine. Below are evaluation runs that failed in a',
    'Chinese-court patent-judicial dossier review scenario. They have been deterministically',
    'clustered and routed to one edit surface. You may only propose changes inside that surface',
    'and only within the given closed value sets; you can never apply any configuration.',
    '',
    `failure tag: ${MAST_LABEL[cluster.tag] ?? cluster.tag} (${cluster.tag})`,
    `edit surface: ${surfaceLabel(route.surface)}`,
    `attributable seam: ${route.seam}`,
    dslAllowed.length ? `DSL fields the middleware surface may change (these only): ${dslAllowed.join(', ')} (suggested values ${JSON.stringify(route.dsl)})` : 'This edit surface may not change any DSL field.',
    route.guideStyle ? `suggested guide pack on the prompt surface: guides=${route.guideStyle}` : '',
    '',
    'Evidence runs:',
    evidence.body,
    '',
    `current DSL config: ${JSON.stringify(baseConfig)}`,
    '',
    'Output strict JSON only (no markdown fences, no extra prose), shaped like:',
    '{',
    '  "title": "change-card title (English, <= 8 words)",',
    '  "nl": "why this change fixes the failure, and on what evidence (English, 2-4 sentences)",',
    '  "guideText": "guidance text appended on the prompt/joint surface (plain natural language, 2-4 items, injected verbatim into the system prompt; WRITE THIS IN CHINESE, the language of the failing runs; empty string on the middleware surface)",',
    `  "middleware": ${dslAllowed.length ? JSON.stringify(route.dsl) : '{}'}`,
    '}',
    'middleware may only set the fields listed above; anything else is flagged as an out-of-table candidate and forced to human review.',
  ].filter(Boolean).join('\n')
}

interface LlmProposal {
  title?: string
  nl?: string
  guideText?: string
  middleware?: Record<string, unknown>
}

function parseProposal(text: string): LlmProposal | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as LlmProposal
  } catch {
    return null
  }
}

const TEMPLATE_GUIDE: Partial<Record<EvoCluster['tag'], string>> = {
  'fail-to-clarify': '在信息不足以下结论前，先列出你需要澄清的 1–3 个关键问题（缺失的卷内证据、技术事实或当事人诉求）；信息可由卷内材料补齐时先检索补齐，不要臆测。',
  'spec-misinterpretation': '严格按审理规格逐项作答：先识别本案请求类型与争议焦点，再逐项展开，覆盖全部子问题；引用法律须给出法名与具体条款。',
  'task-derailment': '先建立任务清单（争议焦点→检索→比对→结论），每完成一项再进入下一项，不要展开与审理任务无关的论述。',
  'weak-grounding': '每条结论必须挂靠卷内证据或权威法条；先检索后下结论，引用前自行核条，无法佐证的判断明确标注为待证。',
  'reasoning-action-mismatch': '采取任何行动前先陈述依据：要证明什么、需要哪个工具/条款；行动后核对结果是否回应了待证问题。',
}

export interface FactoryContext {
  config: HarnessConfig
  mounts: PgMounts
  /** Number of repair-split tasks (for the optimistic pre-apply gain estimate). */
  repairTotal: number
}

/**
 * Build and persist change cards for one cluster. Returns 0–2 cards.
 * 'other' clusters get a non-appliable human-review card.
 */
export async function buildCardsForCluster(
  cluster: EvoCluster,
  runs: RunDetail[],
  ctx: FactoryContext,
): Promise<ChangeCard[]> {
  const evidence = buildEvidence(cluster, runs)
  const applied = appliedSurfacesForCluster(cluster.clusterId)
  const decision = routeCluster(cluster.tag, applied)

  // Forced human review (other / off-table cluster).
  if (decision.surface === 'human') {
    const card: ChangeCard = {
      cardId: id('card'),
      clusterId: cluster.clusterId,
      createdAt: now(),
      surface: 'middleware',
      seam: 'human review',
      title: `Human review: ${MAST_LABEL[cluster.tag] ?? cluster.tag}`,
      nl: decision.reason,
      promptDiff: null,
      middlewareDiff: null,
      mountDiff: null,
      surfaceReason: decision.reason,
      inTable: false,
      predictedGainPp: null,
      hardGate: true,
      status: 'proposed',
      verdict: 'needs-human',
      llmPrompt: null,
      llmOutput: null,
      proposalSource: 'template',
    }
    insertCard(card)
    return [card]
  }

  const route = decision
  const llmPrompt = buildPrompt(cluster, route, evidence, ctx.config)
  let proposal: LlmProposal | null = null
  let llmOutput: string | null = null
  let proposalSource: 'llm' | 'template' = 'template'

  const target = resolveChatTarget()
  if (!('error' in target)) {
    try {
      const res = await chatCompletion(target, {
        messages: [
          { role: 'system', content: 'You are a rigorous agent-harness evolution advisor. Output schema-valid JSON only.' },
          { role: 'user', content: llmPrompt },
        ],
        temperature: 0.2,
        maxTokens: 900,
      })
      llmOutput = res.text
      proposal = parseProposal(res.text)
      if (proposal) proposalSource = 'llm'
    } catch {
      proposal = null // fall through to deterministic template
    }
  }

  // Deterministic in-table patch from the router (always safe).
  const routedFields = new Set(Object.keys(route.dsl))
  const middleware: Partial<HarnessConfig> = { ...route.dsl }
  let inTable = true
  let llmMiddleware: Partial<HarnessConfig> | null = null

  if (proposal?.middleware && Object.keys(proposal.middleware).length) {
    const v = validateMiddleware(proposal.middleware, routedFields)
    if (v.rejected.length === 0) {
      // Prefer the LLM's value on the routed field; record any extra legal
      // combination separately as an out-of-table candidate.
      const onRoute: Partial<HarnessConfig> = {}
      const offRoute: Partial<HarnessConfig> = {}
      for (const [k, val] of Object.entries(v.valid)) {
        if (routedFields.has(k)) (onRoute as Record<string, unknown>)[k] = val
        else (offRoute as Record<string, unknown>)[k] = val
      }
      if (Object.keys(onRoute).length) Object.assign(middleware, onRoute)
      if (Object.keys(offRoute).length) llmMiddleware = { ...route.dsl, ...offRoute }
      if (!v.inTable) inTable = false
    }
  }

  const guideText = proposal?.guideText?.trim() || TEMPLATE_GUIDE[cluster.tag] || ''
  const title = proposal?.title?.trim() || defaultTitle(route.surface, cluster.tag)
  const nl = proposal?.nl?.trim() || defaultNl(route, cluster.tag)

  // Predicted gain is on DISTINCT TASKS (a task may have several failed runs
  // across configs); cluster.count is run count and must not be used here.
  const distinctTasks = cluster.taskIds.length
  const predictedGainPp = ctx.repairTotal > 0
    ? Math.min(100, Math.round((distinctTasks / ctx.repairTotal) * 1000) / 10)
    : null

  const cards: ChangeCard[] = []

  // Primary card: deterministic in-table patch + LLM wording.
  const primary: ChangeCard = {
    cardId: id('card'),
    clusterId: cluster.clusterId,
    createdAt: now(),
    surface: route.surface,
    seam: route.seam,
    title,
    nl,
    promptDiff: route.surface === 'middleware' || !guideText
      ? null
      : { guides: guideText, guideStyle: route.guideStyle },
    middlewareDiff: route.surface === 'prompt' ? null : middleware,
    mountDiff: Object.keys(route.mount).length ? route.mount : null,
    surfaceReason: route.reason,
    inTable: inTable && surfaceIsInTable(route.surface, true),
    predictedGainPp,
    hardGate: route.hardGate,
    status: 'proposed',
    verdict: 'pending',
    llmPrompt: proposalSource === 'llm' ? llmPrompt : null,
    llmOutput: proposalSource === 'llm' ? llmOutput : null,
    proposalSource,
  }
  cards.push(primary)

  // Optional second candidate: a legal-but-off-table combination → human review.
  if (llmMiddleware && Object.keys(llmMiddleware).some((k) => !routedFields.has(k))) {
    cards.push({
      ...primary,
      cardId: id('card'),
      createdAt: now(),
      title: `${title} (out-of-table combination)`,
      nl: `${nl}\n\n[out-of-table candidate] the LLM proposed a control combination outside the routed seam; human confirmation required.`,
      middlewareDiff: llmMiddleware,
      inTable: false,
      hardGate: true,
      verdict: 'needs-human',
      promptDiff: null,
    })
  }

  for (const c of cards) insertCard(c)
  return cards
}

function surfaceIsInTable(_surface: EvoSurface, base: boolean): boolean {
  return base
}

function defaultTitle(surface: EvoSurface, tag: EvoCluster['tag']): string {
  const label = MAST_LABEL[tag] ?? tag
  if (surface === 'prompt') return `${label}: stronger guidance text`
  if (surface === 'joint') return `${label}: guidance + deterministic backstop`
  return `${label}: deterministic control backstop`
}

function defaultNl(route: RoutingDecision, tag: EvoCluster['tag']): string {
  const label = MAST_LABEL[tag] ?? tag
  if (route.surface === 'prompt') {
    return `"${label}" is a cognitive/process gap that instructions can teach; strengthen guidance on the prompt surface (${route.seam}) without touching deterministic behaviour.`
  }
  if (route.surface === 'joint') {
    return `"${label}" shows both a cognitive gap and unstable execution; change the guidance text together with ${route.seam} so each can be ablated.`
  }
  return `"${label}" cannot be taught by instruction and needs a deterministic backstop; add a control at ${route.seam} so the failure cannot happen.`
}
