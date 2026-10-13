// Statute lookup for the live Playground scorer (M1). Builds an article-number
// index from the knowledge DB chunks, so citation verification checks the
// actual statute text rather than trusting the model. M2's local MCP tool
// patent_law_get_article / patent_law_verify_citation reuses this module.
import { getAllChunks, getAllSources } from '../knowledge/db'

// ── law aliases → knowledge-base source file name matcher ──
export interface LawAlias {
  key: string
  displayName: string
  /** matches the KB source file name */
  fileMatch: RegExp
  /** matches a citation to this law inside an answer */
  citePattern: RegExp
  /** guideline-style document (section numbers, not 第X条) */
  guideline?: boolean
}

export const LAW_ALIASES: LawAlias[] = [
  {
    key: 'patent-law',
    displayName: '中华人民共和国专利法',
    fileMatch: /专利法_2020修正\.txt$/,
    citePattern: /专利法(?!实施细则)/,
  },
  {
    key: 'implementing-regulations',
    displayName: '专利法实施细则',
    fileMatch: /专利法实施细则_2023\.txt$/,
    citePattern: /专利法实施细则|实施细则/,
  },
  {
    key: 'guideline',
    displayName: '专利审查指南',
    fileMatch: /^专利审查指南\.pdf$/,
    citePattern: /审查指南|指南第二部分|指南第[一二三四]部分/,
    guideline: true,
  },
  {
    key: 'infringement-interp-1',
    displayName: '最高法关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
    fileMatch: /侵权司法解释一_2009/,
    citePattern: /侵犯专利权纠纷案件应用法律若干问题的解释(?:（?一）?)?(?!（?二）?)/,
  },
  {
    key: 'infringement-interp-2',
    displayName: '最高法关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）',
    fileMatch: /侵权司法解释二_2020/,
    citePattern: /侵犯专利权纠纷案件应用法律若干问题的解释(?:（?二）?)/,
  },
  {
    key: 'grant-validation-interp-1',
    displayName: '最高法关于审理专利授权确权行政案件适用法律若干问题的解释（一）',
    fileMatch: /授权确权司法解释一_2020/,
    citePattern: /专利授权确权.*?司法解释(?:（?一）?)?/,
  },
  {
    key: 'patent-disputes-rules',
    displayName: '最高法关于审理专利纠纷案件适用法律问题的若干规定',
    fileMatch: /专利纠纷案件若干规定_2020/,
    citePattern: /审理专利纠纷案件适用法律问题的若干规定|专利纠纷案件.*?若干规定/,
  },
]

const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** Parse Chinese (第二十二条) or Arabic (第22条) numerals; supports up to hundreds. */
export function chineseNumeralToInt(s: string): number | null {
  const t = s.trim()
  if (/^\d+$/.test(t)) return parseInt(t, 10)
  let total = 0
  let section = 0
  let digit = 0
  let sawUnit = false
  for (const ch of t) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch]
    } else if (ch === '十') {
      section += (digit === 0 ? 1 : digit) * 10
      digit = 0
      sawUnit = true
    } else if (ch === '百') {
      section += (digit === 0 ? 1 : digit) * 100
      digit = 0
      sawUnit = true
    } else {
      return null
    }
  }
  total = section + digit
  return sawUnit || digit > 0 ? total : null
}

function intToChinese(n: number): string {
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (n <= 10) return n === 10 ? '十' : digits[n]
  if (n < 20) return '十' + digits[n - 10]
  if (n < 100) {
    const tens = Math.floor(n / 10)
    const ones = n % 10
    return digits[tens] + '十' + (ones ? digits[ones] : '')
  }
  const hundreds = Math.floor(n / 100)
  const rest = n % 100
  let s = digits[hundreds] + '百'
  if (rest === 0) return s
  if (rest < 10) return s + '零' + digits[rest]
  if (rest < 20) return s + '一十' + (rest % 10 ? digits[rest % 10] : '')
  return s + intToChinese(rest)
}

/**
 * Separator that stands between two digits and is therefore part of the value:
 * `2-5mm`, `0.1-0.3mm`, `2024-03-15`. It is kept as a boundary rather than deleted,
 * because deleting it is what made `25mm` indistinguishable from `2-5mm`.
 */
const DIGIT_SEP = '\u0000'

/**
 * Normalization for gold-term matching.
 *
 * Built on Unicode NFKC — the same compatibility normalization search engines apply
 * before matching, and the reason this file no longer carries a hand-picked list of
 * dash characters. NFKC folds full-width and compatibility forms onto ASCII
 * (`－`→`-`, `２０２４`→`2024`, `（`→`(`), which is the bulk of what a model emits
 * differently from one run to the next. Accent removal follows the documented ICU
 * recipe (decompose → drop combining marks → recompose).
 *
 * Note on what NFKC does *not* do: it takes U+2011 (non-breaking hyphen) only as far
 * as U+2010, not to ASCII `-`. There is no Unicode normalization that folds the whole
 * dash family together — they are distinct characters. (The one spec that drafted such
 * a table, UTR #30 "Character Foldings", was **withdrawn** by the UTC in 2008 and must
 * not be cited as a standard.) So the dash family is handled structurally instead: any
 * non-alphanumeric separator sitting between two digits collapses to `DIGIT_SEP`, which
 * makes every dash, tilde and slash variant of the same number compare equal without
 * enumerating them.
 *
 * The separator is preserved rather than stripped, which is the fix for the old
 * behaviour: stripping made `2-5mm` and `25mm` the same string, so the scorer could not
 * tell a range from a single value.
 */
export function normalizeText(s: string): string {
  return s
    // A literal NUL can only arrive from a hostile import; it would forge a separator.
    .replace(/\u0000/g, '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC')
    // Whitespace never carries meaning in this comparison.
    .replace(/\s+/gu, '')
    // Collapse digit-adjacent separators (any width, any dash, slash or dot-family run)
    // onto one boundary, and drop every other non-alphanumeric character. ASCII "." is
    // kept outright because guideline section numbers (3.2.1.1) depend on it.
    .replace(/(?<=\d)[^\p{L}\p{N}.]+(?=\d)/gu, DIGIT_SEP)
    .replace(/[^\p{L}\p{N}.\u0000]/gu, '')
}

interface LawDoc {
  key: string
  sourceName: string
  /** normalized full text */
  norm: string
  /** article number (int) → normalized article text */
  articles: Map<number, string>
}

let docsCache: LawDoc[] | null = null

function buildDoc(alias: LawAlias): LawDoc | null {
  const src = getAllSources().find((x) => alias.fileMatch.test(x.name))
  if (!src) return null
  const chunkTexts = getAllChunks()
    .filter((c) => c.sourceId === src.id)
    .sort((a, b) => a.index - b.index)
    .map((c) => c.text)
  const norm = normalizeText(chunkTexts.join('\n'))
  const articles = new Map<number, string>()
  if (!alias.guideline) {
    // Chunks are article-segmented at ingest time, often carrying 1-2 articles
    // each (e.g. one chunk holds 第一条+第二条). Within a chunk we accept only
    // the run of consecutively-numbered, non-prefixed boundaries starting from
    // the chunk's first article; cross-references (far numbers / prefixed) are
    // citations and never terminate an article.
    // Boundary detection relies on the strong invariant that statute articles
    // are numbered consecutively. We collect EVERY 第X条 occurrence in the chunk
    // and greedily keep the run n, n+1, n+2 … starting from the chunk's first
    // article. An in-article cross-reference (e.g. 第十三条 quoting 专利法第五十九条,
    // or 第一条 ending in "制定本法" right before 第二条) carries a far-ahead /
    // prefixed number and is skipped by the consecutiveness check, so it never
    // terminates the real article.
    const re = /第([一二三四五六七八九十百零〇两0-9]+)条/g
    for (const raw of chunkTexts) {
      const cn = normalizeText(raw)
      const candidates: Array<{ n: number; idx: number }> = []
      let m: RegExpExecArray | null
      while ((m = re.exec(cn)) !== null) {
        const n = chineseNumeralToInt(m[1]!)
        if (n != null) candidates.push({ n, idx: m.index })
      }
      if (candidates.length === 0) continue
      let expected = candidates[0]!.n
      const bounds: Array<{ n: number; idx: number }> = []
      for (const c of candidates) {
        if (c.n === expected) {
          bounds.push(c)
          expected += 1
        }
      }
      for (let i = 0; i < bounds.length; i++) {
        const endIdx = i + 1 < bounds.length ? bounds[i + 1]!.idx : cn.length
        const text = cn.slice(bounds[i]!.idx, Math.min(endIdx, bounds[i]!.idx + 6000))
        const prev = articles.get(bounds[i]!.n)
        if (!prev || text.length > prev.length) articles.set(bounds[i]!.n, text)
      }
    }
  }
  return { key: alias.key, sourceName: src.name, norm, articles }
}

export function getLawDocs(): LawDoc[] {
  if (docsCache) return docsCache
  docsCache = LAW_ALIASES.map(buildDoc).filter((d): d is LawDoc => d !== null)
  return docsCache
}

/** Test/seed helper: force re-index after ingesting new sources. */
export function resetLawDocCache(): void {
  docsCache = null
}

export interface LocatedArticle {
  lawKey: string
  displayName: string
  sourceName: string
  article?: number
  clause?: number
  section?: string
  /** normalized located text */
  text: string
  snippet: string
}

function locateGuidelineSection(doc: LawDoc, section: string): string | null {
  // section e.g. "第二部分第四章3.2.1.1" or "第二部分第二章2.1"
  const partMatch = section.match(/^(第[一二三四五六七八九十]+部分(?:第[一二三四五六七八九十]+章)?)?(\d+(?:\.\d+)+)/)
  if (!partMatch) return null
  const part = partMatch[1]
  const no = partMatch[2]
  let from = 0
  if (part) {
    const pIdx = doc.norm.indexOf(part)
    if (pIdx < 0) return null
    from = pIdx
  }
  const hay = doc.norm.slice(from)
  // section number followed by a title character (not another digit/dot)
  const re = new RegExp(no.replace(/\./g, '\\.') + '(?=[^0-9.])')
  const m = hay.match(re)
  if (!m || m.index == null) return null
  const start = from + m.index
  // end at the next sibling section number
  const nextNo = (() => {
    const parts = no.split('.')
    const parent = parts.slice(0, -1).join('.')
    const leaf = parseInt(parts[parts.length - 1]!, 10) + 1
    return `${parent}.${leaf}`
  })()
  const nextRe = new RegExp(nextNo.replace(/\./g, '\\.') + '(?=[^0-9.])')
  const rest = hay.slice(m.index + no.length)
  const nm = rest.match(nextRe)
  const end = nm && nm.index != null ? start + no.length + nm.index : start + 3000
  return doc.norm.slice(start, Math.min(end, start + 6000))
}

export function locateArticle(ref: {
  law: string
  article?: string
  clause?: string
  section?: string
}): LocatedArticle | null {
  const doc = getLawDocs().find((d) => d.key === ref.law)
  if (!doc) return null
  const alias = LAW_ALIASES.find((a) => a.key === ref.law)!
  if (alias.guideline) {
    if (!ref.section) return null
    const text = locateGuidelineSection(doc, ref.section)
    if (!text) return null
    return {
      lawKey: ref.law,
      displayName: alias.displayName,
      sourceName: doc.sourceName,
      section: ref.section,
      text,
      snippet: text.slice(0, 220),
    }
  }
  const n = ref.article ? parseInt(ref.article, 10) : NaN
  if (!Number.isFinite(n)) return null
  const text = doc.articles.get(n)
  if (!text) return null
  // M1 returns the whole article text; clause (款) is carried as a label for
  // the UI. Clause-level slicing lands with the M2 MCP verify_citation tool.
  const clause = ref.clause ? parseInt(ref.clause, 10) : undefined
  return {
    lawKey: ref.law,
    displayName: alias.displayName,
    sourceName: doc.sourceName,
    article: n,
    clause,
    text,
    snippet: text.slice(0, 220),
  }
}

export interface RawCitation {
  lawKey: string
  article: number
  raw: string
}

/** Extract every 专利法/细则/司法解释 第X条 citation appearing in an answer. */
export function extractCitations(answerNorm: string): RawCitation[] {
  const out: RawCitation[] = []
  // 名字与「第X条」之间允许的间隔，原为 `[^第。；]{0,8}?`。
  // 8 太窄：答案里很常见的带文号写法是
  //   「…若干问题的解释》（法释〔2009〕21号）第七条」
  // 中间隔着 14 个字符，于是这条引用被整个漏掉 → answerCitesArticle 返回 false
  // → assertion 落成 no_citation → 整条 run 被误判（实测 L17 C2 rep1，
  // 答复明明引了司法解释一第七条，却被判"该引未引"）。
  //
  // 放宽到 24 是安全的：间隔里不允许出现「第」，所以懒匹配**永远配到最近的那个
  // 「第…条」**，不可能跨过另一条去张冠李戴；不允许「。」「；」也就不跨句。
  //
  // 同一处还补了法条名的**常用简写**：实测 L19 C2 的答复写的是「根据侵权解释一第六条」，
  // 全称分支匹配不到，同样落成 no_citation。
  const re = /(专利法实施细则|侵犯专利权纠纷案件应用法律若干问题的解释（[一二]）|侵犯专利权纠纷案件应用法律若干问题的解释|侵权解释[（(]?[一二][）)]?|专利法|专利授权确权[^第]{0,30}?司法解释（[一二]）?|审理专利纠纷案件适用法律问题的若干规定)[^第。；]{0,24}?第([一二三四五六七八九十百零〇两0-9]+)条/g
  let m: RegExpExecArray | null
  while ((m = re.exec(answerNorm)) !== null) {
    const name = m[1] ?? ''
    const n = chineseNumeralToInt(m[2]!)
    if (n == null) continue
    let lawKey = 'patent-law'
    if (/实施细则/.test(name)) lawKey = 'implementing-regulations'
    else if (/若干规定/.test(name)) lawKey = 'patent-disputes-rules'
    else if (/授权确权/.test(name)) lawKey = 'grant-validation-interp-1'
    else if (/解释[（(]?二[）)]?/.test(name)) lawKey = 'infringement-interp-2'
    else if (/解释/.test(name)) lawKey = 'infringement-interp-1'
    out.push({ lawKey, article: n, raw: m[0] })
  }
  return out
}

/** Whether a specific statute citation is present in the answer. */
export function answerCitesArticle(answerNorm: string, lawKey: string, article: number): boolean {
  return extractCitations(answerNorm).some((c) => c.lawKey === lawKey && c.article === article)
}

/** Whether a guideline section is referenced (by its section number). */
export function answerCitesSection(answerNorm: string, section: string): boolean {
  const no = section.match(/(\d+(?:\.\d+)+)/)
  if (!no) return answerNorm.includes(normalizeText(section))
  return answerNorm.includes(no[1])
}
