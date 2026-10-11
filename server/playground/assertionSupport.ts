// 运行时引用支撑判定：一条引用到底被所引条文支撑到什么程度（设计 §10 M2 记录契约）。
//
// 为什么不用字符 n-gram：法律文书的「法条正文」与「审理说理」是两种文体，
// 同一概念的说法几乎不重合。4-gram 重叠会把
// 「本申请的创造性判断应当适用专利法第二十二条第三款所确立的三步法」
// 这种完全正确的说理判成 unsupported（实测重叠率 0.071），进而误触
// verifier 驳回与一次无谓的重写。缺词汇重叠**不是**"没有支撑"的证据。
//
// 三条判定口径：
//   1. 条文本身查不到 → citation_unreachable（引用不可达），与 scorer 的口径一致；
//      绝不与「有条文但没支撑」混成一个标签。
//   2. 术语覆盖率法：抽取说理句里的法律概念词，看条文是否覆盖。
//   3. 诚实下限：条文能查到时，最差只判 partially_supported；
//      `unsupported` 只留给能指出具体矛盾的确定性情形，不靠"没匹配上"推定。
import type { LegalAssertion } from '../../shared/legal'

/**
 * 法律概念词表：抽取说理句的「说了什么法律事」，再问条文「有没有讲这件事」。
 * 顺序无关（用 Set 匹配），命中最长词优先，避免「新颖性」被「新颖」抢先。
 */
const LEGAL_TERMS: string[] = [
  // 专利法实体要件
  '新颖性', '创造性', '实用性', '现有技术', '现有设计', '抵触申请', '宽限期',
  '优先权', '不丧失新颖性', '技术启示', '显而易见', '实质性特点', '显著进步',
  '充分公开', '说明书', '权利要求书', '独立权利要求', '从属权利要求', '技术特征',
  '区别技术特征', '技术方案', '有益效果', '背景技术', '实施方式', '单一性',
  '修改超范围', '禁止反悔', '禁止反悔原则',
  // 程序
  '复审', '复审请求', '驳回', '驳回理由', '意见陈述书', '无效', '无效宣告',
  '主动审查', '审查员', '申请人', '专利权人', '代理机构', '期限', '恢复', '中止',
  '公告', '公开', '记载', '申请日', '优先申请日', '授权', '撤销',
  // 侵权与确权
  '侵权', '全面覆盖', '等同', '等同原则', '等同特征', '禁止反悔', '许可', '转让',
  '赔偿', '抗辩', '在先使用', '先用权', '举证责任', '停止侵害', '消除影响',
  '管辖', '时效', '证据', '公证', '查封', '保全',
]

/** 说明性套话：出现在说理句里但没有法律含义，不能计入覆盖率分母。 */
const STOPWORDS = new Set([
  '本申请', '本案', '本院', '上述', '下文', '因此', '综上', '据此', '首先', '其次',
  '最后', '应当', '可以', '需要', '进行', '认为', '指出', '说明', '以及', '或者',
  '并且', '但是', '如果', '由于', '通过', '根据', '按照',
])

const sortedTerms = [...LEGAL_TERMS].sort((a, b) => b.length - a.length)

/** 抽取文本里出现的法律概念词（长词优先，避免子串重复计数）。 */
export function keyTerms(text: string): string[] {
  const hit: string[] = []
  const consumed = new Array<boolean>(text.length).fill(false)
  for (const term of sortedTerms) {
    let from = 0
    for (;;) {
      const i = text.indexOf(term, from)
      if (i < 0) break
      let free = true
      for (let k = i; k < i + term.length; k++) if (consumed[k]) { free = false; break }
      if (free) {
        for (let k = i; k < i + term.length; k++) consumed[k] = true
        hit.push(term)
      }
      from = i + term.length
    }
  }
  return hit
}

function chars(s: string): Set<string> {
  return new Set([...s].filter((c) => /[\p{Script=Han}a-zA-Z0-9]/u.test(c)))
}

export interface SupportVerdict {
  label: LegalAssertion
  /** Why — shown next to the event so a low label is never a black box. */
  reason: string
  coverage: number
  matched: string[]
}

/**
 * Judge whether `sentence` is supported by `articleText`.
 * `articleText` must be a *resolved* statute; a missing statute never reaches here.
 */
export function supportOf(sentence: string, articleText: string): SupportVerdict {
  const terms = [...new Set(keyTerms(sentence))].filter((t) => !STOPWORDS.has(t))
  const artTerms = new Set(keyTerms(articleText))

  if (terms.length > 0) {
    const matched = terms.filter((t) => artTerms.has(t))
    const coverage = matched.length / terms.length
    if (coverage >= 0.6) {
      return { label: 'supported', reason: `说理涉及的 ${matched.length}/${terms.length} 个法律概念在所引条文中均有对应`, coverage, matched }
    }
    if (matched.length > 0) {
      return {
        label: 'partially_supported',
        reason: `说理涉及 ${terms.length} 个法律概念，条文覆盖 ${matched.length} 个（${matched.join('、')}）`,
        coverage,
        matched,
      }
    }
    // 条文查得到、但一个概念都没覆盖：合法条文的用词与说理用词不同族时也会走到这里。
    // 词汇不重合**不等于**矛盾，所以按诚实下限只判部分支撑，不凭空判 unsupported。
    return {
      label: 'partially_supported',
      reason: `所引条文真实存在，但说理用词与条文用词无交集（说理涉及：${terms.join('、')}），词面无法判定支撑，按下限记为部分支撑`,
      coverage: 0,
      matched: [],
    }
  }

  // 说理句里没有可识别的法律概念词：退到字面重合，只做「明显贴合 / 明显不贴」的弱判断。
  const sent = chars(sentence)
  const art = chars(articleText)
  if (sent.size === 0) {
    return { label: 'partially_supported', reason: '说理句为空，无法判定支撑', coverage: 0, matched: [] }
  }
  const shared = [...sent].filter((c) => art.has(c))
  const coverage = shared.length / sent.size
  if (coverage >= 0.75) {
    return { label: 'supported', reason: `说理句与条文字面重合度 ${(coverage * 100).toFixed(0)}%`, coverage, matched: [] }
  }
  return {
    label: 'partially_supported',
    reason: `说理句未出现可识别的法律概念词，字面重合度 ${(coverage * 100).toFixed(0)}%，记为部分支撑`,
    coverage,
    matched: [],
  }
}

/** 条文在知识库里查不到 —— 引用不可达，与「有条文但没支撑」严格分开。 */
export const UNREACHABLE: LegalAssertion = 'citation_unreachable'
