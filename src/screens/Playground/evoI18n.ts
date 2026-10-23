// Display localization for the self-evolution workspace.
//
// Evolution cards, clusters, route reasons, auto-job phases and race outcomes
// are produced and stored server-side in English (older rows may be mixed
// Chinese/English). The API is language-agnostic, so the panel localizes at the
// display edge: fixed vocabulary goes through the fixture dictionary, and
// templated sentences are rebuilt from structured fields. Nothing here mutates
// stored data.
import { useMemo } from 'react'
import { fixture, t, useI18n, type Language } from '../../i18n'
import { MAST_LABEL } from '../../../shared/mast'
import type {
  ChangeCard,
  EvoCluster,
  EvoGeneration,
  PgDomain,
} from '../../../shared/playground'

const HAN = /\p{Script=Han}/u
export const hasHan = (text: string): boolean => HAN.test(text)

type Params = Record<string, string | number>

function phaseLabelKey(phase: string): string {
  return `playground.evo.phase.${phase}`
}

export function makeEvoI18n(lang: Language) {
  const en = lang === 'en'
  const tr = (key: string, params?: Params) => t(key, lang, params)
  const fx = (text: string) => fixture(text, lang)

  const surface = (s: string | null | undefined): string => {
    if (!s) return '—'
    const key = `playground.evo.surface.${s}`
    const out = tr(key)
    return out === key ? s : out
  }

  const domain = (d: PgDomain | 'mixed' | null | undefined): string => {
    if (!d) return '—'
    const key = `playground.evo.domain.${d}`
    const out = tr(key)
    return out === key ? d : out
  }

  const domainScope = (d: PgDomain | 'mixed' | null | undefined): string => {
    if (!d) return '—'
    const key = `playground.evo.domainScope.${d}`
    const out = tr(key)
    return out === key ? d : out
  }

  const phase = (p: string): string => {
    const key = phaseLabelKey(p)
    const out = tr(key)
    return out === key ? p : out
  }

  const autonomy = (level: number): string => {
    const key = `playground.evo.autonomy.${level}`
    const out = tr(key)
    return out === key ? tr('playground.evo.autonomyUnknown') : out
  }

  const mast = (tag: string | null | undefined): string => {
    if (!tag) return ''
    const label = MAST_LABEL[tag as keyof typeof MAST_LABEL] ?? tag
    return fx(label)
  }

  const seam = (s: string | null | undefined): string => {
    if (!s) return '—'
    return hasHan(s) ? s : fx(s)
  }

  const clusterSummary = (cluster: EvoCluster): string => {
    if (en || hasHan(cluster.summary)) return cluster.summary
    return tr('playground.evo.clusterSummary', {
      count: cluster.count,
      tag: mast(cluster.tag),
      seam: seam(cluster.seam),
      scope: domainScope(cluster.domain),
    })
  }

  const routeReason = (raw: string | null | undefined): string => {
    if (!raw) return ''
    if (en || hasHan(raw)) return raw
    const parts = raw.split('; ')
    return parts
      .map((part) => {
        const byDefault = part.match(/^routing table default: (\S+) → (\S+) surface \(seam: (.+)\)$/)
        if (byDefault) {
          return tr('playground.evo.route.default', {
            tag: mast(byDefault[1]),
            surface: surface(byDefault[2]),
            seam: seam(byDefault[3]),
          })
        }
        if (part.startsWith('prompt and joint already applied and the next generation still failed')) {
          return tr('playground.evo.route.upgradeBoth')
        }
        if (part.startsWith('prompt already applied and the next generation still failed')) {
          return tr('playground.evo.route.upgradeJoint')
        }
        if (part.startsWith('joint already applied and the next generation still failed')) {
          return tr('playground.evo.route.upgradeMiddleware')
        }
        const human = part.match(/^Failure tag "(.+)" is outside the closed routing table/)
        if (human) return tr('playground.evo.route.human', { tag: mast(human[1]) })
        return part
      })
      .join('；')
  }

  const cardTitle = (card: ChangeCard, cluster?: EvoCluster | null): string => {
    if (!card) return ''
    let base = card.title.trim()
    let suffix = ''
    const outTable = ' (out-of-table combination)'
    if (base.endsWith(outTable)) {
      base = base.slice(0, -outTable.length)
      suffix = en ? outTable : tr('playground.evo.card.outTableSuffix')
    }
    if (en) {
      // Old rows may hold Chinese templates even though the current locale is
      // English; normalize their vocabulary when it is unambiguous.
      const humanZh = base.match(/^人工研判[：:]\s*(.+)$/)
      if (humanZh) return `Human review: ${humanZh[1]!.trim()}${suffix}`
      const templateZh = base.match(/^(.+?)[：:]\s*(强化引导文本|引导\s*[+＋]\s*确定性兜底|确定性控制兜底)$/)
      if (templateZh) {
        const kind = templateZh[2]! === '强化引导文本'
          ? 'stronger guidance text'
          : templateZh[2]!.startsWith('引导')
            ? 'guidance + deterministic backstop'
            : 'deterministic control backstop'
        return `${templateZh[1]!.trim()}: ${kind}${suffix}`
      }
      return base + suffix
    }
    const human = base.match(/^Human review: (.+)$/)
    if (human) return tr('playground.evo.card.humanTitle', { tag: fx(human[1]!) }) + suffix
    const humanZh = base.match(/^人工研判[：:]\s*(.+)$/)
    if (humanZh) {
      return tr('playground.evo.card.humanTitle', { tag: fx(humanZh[1]!.trim()) }) + suffix
    }
    const template = base.match(
      /^(.+?): (stronger guidance text|guidance \+ deterministic backstop|deterministic control backstop)$/,
    )
    if (template) {
      const tag = cluster ? mast(cluster.tag) : fx(template[1]!)
      const kindKey = template[2] === 'stronger guidance text'
        ? 'guidance'
        : template[2]!.startsWith('guidance')
          ? 'mixed'
          : 'backstop'
      return tr('playground.evo.card.titleTemplate', {
        tag,
        kind: tr(`playground.evo.card.kind.${kindKey}`),
      }) + suffix
    }
    // Older rows stored the template with Chinese punctuation but kept the
    // English failure-tag label, e.g. "Weak Grounding：引导＋确定性兜底".
    const templateZh = base.match(/^(.+?)[：:]\s*(强化引导文本|引导\s*[+＋]\s*确定性兜底|确定性控制兜底)$/)
    if (templateZh) {
      const kind = templateZh[2]!
      const kindKey = kind === '强化引导文本' ? 'guidance' : kind.startsWith('引导') ? 'mixed' : 'backstop'
      return tr('playground.evo.card.titleTemplate', {
        tag: fx(templateZh[1]!.trim()),
        kind: tr(`playground.evo.card.kind.${kindKey}`),
      }) + suffix
    }
    if (hasHan(base)) return base + suffix
    // Known LLM-authored titles from persisted rows have a fixture translation;
    // arbitrary future titles fall back to the structured tag × surface label.
    const known = fx(base)
    if (known !== base) return known + suffix
    const tag = cluster ? mast(cluster.tag) : tr('playground.evo.card.unknownTag')
    return tr('playground.evo.card.fallbackTitle', { tag, surface: surface(card.surface) }) + suffix
  }

  const cardNl = (card: ChangeCard, cluster?: EvoCluster | null): string => {
    if (!card) return ''
    if (en || hasHan(card.nl)) return card.nl
    let text = card.nl
    let outTable = false
    const marker = '\n\n[out-of-table candidate]'
    const cut = text.indexOf(marker)
    if (cut >= 0) {
      text = text.slice(0, cut)
      outTable = true
    }
    const tag = cluster ? mast(cluster.tag) : tr('playground.evo.card.unknownTag')
    const seamText = seam(card.seam)
    let out: string
    const human = text.match(/^Failure tag "(.+)" is outside the closed routing table/)
    if (human) {
      out = tr('playground.evo.card.humanNl', { tag: mast(human[1]) })
    } else if (text.includes('is a cognitive/process gap that instructions can teach')) {
      out = tr('playground.evo.card.promptNl', { tag, seam: seamText })
    } else if (text.includes('shows both a cognitive gap and unstable execution')) {
      out = tr('playground.evo.card.jointNl', { tag, seam: seamText })
    } else if (text.includes('cannot be taught by instruction and needs a deterministic backstop')) {
      out = tr('playground.evo.card.middlewareNl', { tag, seam: seamText })
    } else {
      const key = card.surface === 'prompt'
        ? 'playground.evo.card.promptNl'
        : card.surface === 'joint'
          ? 'playground.evo.card.jointNl'
          : 'playground.evo.card.middlewareNl'
      out = tr(key, { tag, seam: seamText })
    }
    if (outTable) out += '\n\n' + tr('playground.evo.card.outTableNote')
    return out
  }

  const generationLabel = (
    generation: EvoGeneration,
    card?: ChangeCard | null,
    cluster?: EvoCluster | null,
  ): string => {
    if (generation.source === 'base' || /^(Evolution baseline|演化基线)/.test(generation.label)) {
      return tr('playground.evo.versions.baseLabel')
    }
    // The stored label was copied from the card title at apply time. Going back
    // to the card lets older mixed-language labels ("Weak Grounding：…") pick up
    // the same translations the card itself now gets.
    if (card) return cardTitle(card, cluster)
    if (en || hasHan(generation.label)) return generation.label
    return tr('playground.evo.versions.fallback', { fingerprint: generation.fingerprint })
  }

  const exact: Record<string, string> = {
    'Preparing candidates': 'playground.evo.msg.phase.preparing',
    'Clustering failures (no candidate cards yet)': 'playground.evo.msg.phase.clusteringNoCards',
    'No candidates': 'playground.evo.msg.phase.noCandidates',
    'Winner picked and applied': 'playground.evo.msg.phase.winnerApplied',
    'Winner picked, awaiting human approval': 'playground.evo.msg.phase.winnerAwaiting',
    'Race finished (no winner)': 'playground.evo.msg.phase.raceNoWinner',
    Error: 'playground.evo.msg.phase.error',
    'Starting attribution': 'playground.evo.msg.phase.starting',
    Done: 'playground.evo.msg.phase.done',
    'Awaiting human': 'playground.evo.msg.phase.awaitingHuman',
    Stopped: 'playground.evo.msg.phase.stopped',
    'Limit reached': 'playground.evo.msg.phase.limit',
    'Interrupted by a process restart': 'playground.evo.msg.phase.interrupted',
    'The current baseline has no failed runs left; self-evolution has converged.':
      'playground.evo.msg.stop.converged',
    'Every remaining candidate is a hard-gate / out-of-table / human-judgement card; auto-iteration stops here for human approval.':
      'playground.evo.msg.stop.human',
    'The previous self-evolution run died with the server process; start it again.':
      'playground.evo.msg.stop.previousRun',
    'The previous top-N race died with the server process; start it again.':
      'playground.evo.msg.stop.previousRace',
    'No candidate left on the Pareto frontier (all dominated or regressed).':
      'playground.evo.msg.race.noFrontier',
    'No candidate survived the gate pass.': 'playground.evo.msg.race.noSurvivor',
    'No candidate card to race (click "Cluster failed runs" first to propose cards).':
      'playground.evo.msg.race.noCandidates',
    'The Pareto winner is a hard-gate / out-of-table card: it needs human approval at every level.':
      'playground.evo.msg.race.winnerHardGate',
    'Slider is at level 0 (all manual): a winner was picked but waits for human approval.':
      'playground.evo.msg.race.winnerLevelZero',
    'Failed to apply the winning card.': 'playground.evo.msg.race.applyFailed',
    'failure cluster missing, cannot re-run': 'playground.evo.msg.drop.clusterMissing',
    'no failed run available for re-runs': 'playground.evo.msg.drop.noFailed',
    'repair screen rescued nothing': 'playground.evo.msg.drop.noRescue',
    'lost the Pareto frontier': 'playground.evo.msg.drop.lost',
    'deterministic check regressed': 'playground.evo.msg.drop.deterministic',
    'Change card not found': 'playground.evo.msg.cardMissing',
    'Failure cluster not found': 'playground.evo.msg.clusterMissing',
    'This change card is already applied.': 'playground.evo.msg.alreadyApplied',
    'This card is being falsified by real re-runs; wait for the result.':
      'playground.evo.msg.screening',
    'Slider is at level 0 (all manual) — nothing auto-applies.': 'playground.evo.msg.levelZero',
    'An out-of-table candidate always requires human review.': 'playground.evo.msg.outOfTable',
    'This seam is a security/legal hard gate and always needs human approval.':
      'playground.evo.msg.hardGate',
    'This cluster has no failed run available for re-runs.': 'playground.evo.msg.noFailedRuns',
    'Level 1 (conditional auto): the re-run regressed, so auto-apply is forbidden.':
      'playground.evo.msg.level1Regressed',
    'Falsified: no failed task was rescued — not committed to the version tree.':
      'playground.evo.msg.falsifiedNoRescue',
    'Version not found': 'playground.evo.msg.versionMissing',
    'Change record not found': 'playground.evo.msg.changeMissing',
    'Full gate verification is already running.': 'playground.evo.msg.gateBusy',
    'Candidate or baseline version is missing.': 'playground.evo.msg.versionDataMissing',
    'A top-N race is already running.': 'playground.evo.msg.raceBusy',
    'Continuous self-evolution is running; wait for it to finish first.':
      'playground.evo.msg.autoBusy',
    'Self-evolution is already running.': 'playground.evo.msg.selfBusy',
    'Slider is at level 0 (all manual) — auto-evolution cannot run.':
      'playground.evo.msg.levelZeroAuto',
    'no held-out tasks left to run after exclusions': 'playground.evo.msg.noGateTasks',
    'No failed repair runs — nothing to attribute.': 'playground.evo.msg.noFailedRepair',
    'No failed runs under the current baseline config; failures from other configs are already avoided at this version.':
      'playground.evo.msg.noBaselineFailures',
  }

  const msg = (raw: string | null | undefined): string => {
    if (!raw) return ''
    if (en || hasHan(raw)) return raw
    const hit = exact[raw]
    if (hit) return tr(hit)
    let m = raw.match(/^top-(\d+) race: repair screen → gate×repeats → Pareto$/)
    if (m) return tr('playground.evo.msg.topRace', { n: m[1]! })
    m = raw.match(/^Generation (\d+): clustering failures$/)
    if (m) return tr('playground.evo.msg.generationClustering', { n: m[1]! })
    m = raw.match(/^Generation (\d+): top-(\d+) side-by-side falsification \(repair screen → gate×repeats → Pareto\)$/)
    if (m) return tr('playground.evo.msg.generationFalsify', { gen: m[1]!, top: m[2]! })
    m = raw.match(/^Generation (\d+) applied \(net lift (-?[\d.]+)pp\)$/)
    if (m) return tr('playground.evo.msg.generationApplied', { n: m[1]!, lift: m[2]! })
    m = raw.match(/^Repair screen: (\d+) candidate\(s\) side by side$/)
    if (m) return tr('playground.evo.msg.repairScreenPhase', { n: m[1]! })
    m = raw.match(/^gate×(\d+): (\d+) candidate\(s\) side by side$/)
    if (m) return tr('playground.evo.msg.gatePhase', { reps: m[1]!, n: m[2]! })
    m = raw.match(/^(\d+) consecutive generations with no positive lift; self-evolution stops\.$/)
    if (m) return tr('playground.evo.msg.consecutiveNoLift', { n: m[1]! })
    m = raw.match(/^Hit the (\d+)-generation cap for one auto run; inspect and continue manually\.$/)
    if (m) return tr('playground.evo.msg.capReached', { n: m[1]! })
    m = raw.match(
      /^Clustered (\d+) failure group\(s\) and proposed (\d+) change card\(s\)\. Cards are candidates: they still need real run falsification and the approval gate\.$/,
    )
    if (m) return tr('playground.evo.msg.clustered', { groups: m[1]!, cards: m[2]! })
    m = raw.match(
      /^Inconclusive: (\d+) task\(s\) produced no answer after retries \((.+)\)\. The card stays proposed — re-run verification when the provider is healthy\.$/,
    )
    if (m) return tr('playground.evo.msg.inconclusive', { n: m[1]!, list: m[2]! })
    m = raw.match(/^Falsified: a deterministic check regressed — (.+) — not committed to the version tree\.$/)
    if (m) return tr('playground.evo.msg.falsifiedHard', { reasons: m[1]! })
    m = raw.match(/^Falsified: (\d+) task\(s\) regressed, net lift (-?[\d.]+)pp — not committed to the version tree\.$/)
    if (m) return tr('playground.evo.msg.falsifiedRegressed', { n: m[1]!, lift: m[2]! })
    m = raw.match(
      /^partial: (\d+) run\(s\) produced no answer after retries \((.+)\); this verdict uses only the pairs that answered\.$/,
    )
    if (m) return tr('playground.evo.msg.partial', { n: m[1]!, list: m[2]! })
    m = raw.match(/^repair screen failed: (.+)$/)
    if (m) return tr('playground.evo.msg.repairScreenFailed', { error: m[1]! })
    m = raw.match(/^repair screen inconclusive: (\d+) task\(s\) produced no answer \((.+)\)$/)
    if (m) return tr('playground.evo.msg.repairScreenInconclusive', { n: m[1]!, list: m[2]! })
    m = raw.match(/^repair screen regressed (\d+) task\(s\)$/)
    if (m) return tr('playground.evo.msg.repairScreenRegressed', { n: m[1]! })
    m = raw.match(/^missed the top-(\d+) after the repair screen \(net lift (-?[\d.]+)pp\)$/)
    if (m) return tr('playground.evo.msg.missedTop', { n: m[1]!, lift: m[2]! })
    m = raw.match(/^gate verification failed: (.+)$/)
    if (m) return tr('playground.evo.msg.gateFailed', { error: m[1]! })
    m = raw.match(/^gate regressed (\d+) task\(s\)$/)
    if (m) return tr('playground.evo.msg.gateRegressed', { n: m[1]! })
    m = raw.match(/^gate lift (-?[\d.]+)pp is negative$/)
    if (m) return tr('playground.evo.msg.gateNegative', { lift: m[1]! })
    m = raw.match(
      /^partial: (\d+) task\(s\) never produced an answer \((.+)\); the verdict below uses the (\d+) pairs that did answer$/,
    )
    if (m) return tr('playground.evo.msg.gatePartial', { n: m[1]!, list: m[2]!, pairs: m[3]! })
    m = raw.match(/^Pareto winner "(.+)" — committing to the version tree$/)
    if (m) return tr('playground.evo.msg.race.winnerCommitting', { title: m[1]! })
    m = raw.match(/^Pareto frontier pick "(.+)" \(gate (-?[\d.]+)pp, cost axis (\w+)\)$/)
    if (m) {
      const axisKey = `playground.evo.msg.race.axis.${m[3]}`
      const axis = tr(axisKey)
      return tr('playground.evo.msg.race.winnerPick', {
        title: m[1]!,
        lift: m[2]!,
        axis: axis === axisKey ? m[3]! : axis,
      })
    }
    return raw
  }

  return {
    lang,
    en,
    t: tr,
    hasHan,
    surface,
    domain,
    domainScope,
    phase,
    autonomy,
    mast,
    seam,
    clusterSummary,
    routeReason,
    cardTitle,
    cardNl,
    generationLabel,
    msg,
  }
}

export type EvoI18n = ReturnType<typeof makeEvoI18n>

export function useEvoI18n(): EvoI18n {
  const { lang } = useI18n()
  return useMemo(() => makeEvoI18n(lang), [lang])
}
