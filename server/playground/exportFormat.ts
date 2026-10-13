// Human-readable TXT rendering of one playground run (design §14.1 export
// formats: JSON / JSONL machine formats + TXT human report).
import type { HarnessEvent } from '../../shared/events'
import type { RunDetail } from '../../shared/playground'

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').replace('Z', ' UTC')
}

function eventLine(ev: HarnessEvent): string {
  const t0 = (ev as { ts?: number }).ts ?? 0
  const step = (ev as { step?: number }).step
  const head = `[${fmtTime(t0)}] step${step ?? '-'} ${ev.type} (author=${ev.author})`
  switch (ev.type) {
    case 'run.started':
      return `${head} model=${ev.model} task=${ev.task}`
    case 'model.request':
      return `${head} estTokens=${ev.estTokens} blocks=${ev.blocks.map((b) => `${b.layer}:${b.tokens}`).join(',')}`
    case 'model.response':
      return `${head} stop=${ev.stopReason} text=${ev.thought.replace(/\s+/g, ' ').slice(0, 120)}`
    case 'tool.call':
      return `${head} tool=${ev.tool} args=${ev.argsSummary}`
    case 'tool.result':
      return `${head} tool=${ev.tool} tokens=${ev.tokens} ${ev.summary}`
    case 'shaper.fire':
      return `${head} shaper=${ev.shaper} freed=${ev.freedTokens} ${ev.note}`
    case 'hook.decision':
      return `${head} hook=${ev.hook} verdict=${ev.verdict} ${ev.reason}`
    case 'router.decision':
      return `${head} tool=${ev.tool} route=${ev.route} rule=${ev.matchedRule}`
    case 'permission.request':
      return `${head} scope=${ev.scope} risk=${ev.riskLevel}`
    case 'permission.granted':
      return `${head} scope=${ev.scope} via=${ev.via}`
    case 'permission.denied':
      return `${head} scope=${ev.scope} gate=${ev.gate} ${ev.reason}`
    case 'verifier.verdict':
      return `${head} ${ev.verdict}${ev.failureTag ? ` tag=${ev.failureTag}` : ''} ${ev.reason}`
    case 'legal.assertion':
      return `${head} ${ev.label} <${ev.citedAuthority || '(no citation)'}> claim=${ev.claimText.replace(/\s+/g, ' ').slice(0, 100)}`
    case 'failure.tag':
      return `${head} tag=${ev.mast} conf=${ev.confidence} ${ev.note}`
    case 'run.finished':
      return `${head} success=${ev.success} tokens=${ev.tokens} latencyMs=${ev.latencyP50} tags=${JSON.stringify(ev.failureModes)}`
    default:
      return `${head} ${JSON.stringify(ev).slice(0, 200)}`
  }
}

export function renderRunTxt(detail: Omit<RunDetail, 'events'>, events: HarnessEvent[]): string {
  const lines: string[] = []
  lines.push('═══════════════════════════════════════════════════════════════')
  lines.push('HWT Playground Live Run (TXT export)')
  lines.push('═══════════════════════════════════════════════════════════════')
  lines.push(`runId        : ${detail.runId}`)
  lines.push(`source       : ${detail.source}${detail.source === 'imported' ? ' (external import, not a run of this harness)' : ''}`)
  lines.push(`status       : ${detail.status}`)
  lines.push(`task         : [${detail.taskId}] ${detail.taskTitle}`)
  lines.push(`domain/split : ${detail.domain} / ${detail.split}`)
  lines.push(`preset       : ${detail.presetId ?? '(custom config)'}  fingerprint=${detail.fingerprint.slice(0, 16)}…`)
  lines.push(`ladder rung  : ${detail.configVersion.ladderRung} (mapping ${detail.configVersion.mappingVersion})`)
  lines.push(`model        : ${detail.model}${detail.provider ? ` @ ${detail.provider.baseUrl}` : ''}`)
  lines.push(`temperature  : ${detail.temperature ?? '—'}  seed=${detail.seed ?? '—'}`)
  lines.push(`createdAt    : ${detail.createdAt}`)
  if (detail.materials) {
    lines.push(`materials    : dossier ${detail.materials.dossier.length} 个文件 / legal-kb ${detail.materials.legalKb.sources} sources, ${detail.materials.legalKb.chunks} chunks (${detail.materials.legalKb.digest})`)
  }
  lines.push('─────────────────────────────────────────────────────────────── dossier')
  const dossierWithText = (detail.materials?.dossier ?? []).filter((d) => d.text)
  if (dossierWithText.length === 0) {
    lines.push('(this export carries no dossier body — either an older export or this question has no dossier)')
  } else {
    for (const d of dossierWithText) {
      lines.push(`[dossier file] ${d.file} (${d.chars} chars)`)
      lines.push(d.text ?? '')
      lines.push('')
    }
  }
  lines.push('─────────────────────────────────────────────────────────────── metrics')
  lines.push(`L2 success   : ${detail.success === null ? '—' : detail.success ? 'PASS' : 'FAIL'}  score=${detail.score ?? '—'}  tokens=${detail.tokens ?? '—'}  latencyMs=${detail.latencyMs ?? '—'}`)
  lines.push(`failure tags : ${detail.failureTags.length ? detail.failureTags.join(', ') : '(none)'}`)
  if (detail.error) lines.push(`error        : ${detail.error}`)
  if (detail.verdict) {
    lines.push(`verdict      : ${detail.verdict.summary}`)
    for (const c of detail.verdict.articleChecks) {
      lines.push(`  - ${c.label} → ${c.assertion}${c.articleSnippet ? ` | text: ${c.articleSnippet.slice(0, 80)}…` : ''}`)
    }
    for (const s of detail.verdict.securityChecks) {
      lines.push(`  - security gate ${s.kind}: ${s.passed ? 'PASS' : 'FAIL'} | ${s.detail}`)
    }
  }
  lines.push('─────────────────────────────────────────────────────────────── answer')
  lines.push(detail.answer ?? '(none)')
  lines.push('──────────────────────────────────────────────────────────── trajectory')
  for (const ev of events) lines.push(eventLine(ev))
  lines.push('═══════════════════════════════════════════════════════════════')
  return lines.join('\n')
}
