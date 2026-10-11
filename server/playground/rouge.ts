// Reference-based scoring built on ROUGE (Lin, 2004) — the classic, free,
// recall-oriented metric — instead of hand-rolled synonym groups.
//
// Why not keyword groups: a group has to enumerate every way an answer might
// phrase a point, and enumeration always loses. A real run lost a point for
// writing "卷宗内存在明显的前后矛盾" when the list held only
// "不一致|不一致的|存在两个|存在矛盾"; a different answer got the 技术主题 wrong and
// still scored the point, because the term happened to appear elsewhere in the
// text. ROUGE compares the answer against the task's reference answer directly,
// so wording becomes a matter of degree rather than of guessing the variant.
//
// Two adaptations are needed for this corpus, both picked from measurements on
// the real runs rather than from taste:
//
//   1. Character-level tokenisation. The classic ROUGE tooling assumes
//      whitespace-delimited words, which collapses a whole Chinese sentence into
//      a single token. Character n-grams are the standard adaptation for
//      languages without word delimiters, and need no segmentation dictionary.
//
//   2. A recall-weighted F-measure. The textbook β=1 F-score carries a precision
//      term, so a correct answer that is longer than the reference is punished
//      for its length: on this corpus the runs the per-point scorer marks as
//      perfect include 4,000–6,000 character answers that score under 0.1 at
//      β=1. Sweeping β over 61 real runs, agreement with the per-point verdict
//      climbs from 54% (β=1) to ~74% (β≈32) and then plateaus — so the default
//      weights recall, and the β=1 number is reported alongside it for
//      comparability with published ROUGE results.
//
// `js-rouge` (MIT, no dependencies, TypeScript types) implements the metric; the
// only thing this module adds is the tokeniser and the weighting.
import { l as rougeL, n as rougeN } from 'js-rouge'
import type { RougeReading } from '../../shared/playground'

/** Recall weight of the default reading. See the header for how it was chosen. */
export const ROUGE_RECALL_BETA = 32

/** CJK, kana, latin letters and digits. Whitespace and punctuation are dropped. */
const SCORED_CHAR = /[\u3400-\u9fff\u3040-\u30ffA-Za-z0-9]/

/** Character-level tokens; the standard tokenisation for languages without word delimiters. */
export function charTokens(text: string): string[] {
  return [...text.replace(/\s+/g, '')].filter((c) => SCORED_CHAR.test(c))
}

/** ROUGE of an answer against the task's reference answer. Deterministic. */
export function rougeAgainstReference(answer: string, reference: string): RougeReading {
  const referenceTokens = charTokens(reference).length
  // js-rouge throws on an empty candidate, and an answer with nothing scoreable
  // in it is a normal input here: a failed run stores a placeholder, and the
  // empty-answer check is part of the scorer's contract. Zero is the honest
  // reading — nothing of the reference is present.
  if (charTokens(answer).length === 0 || referenceTokens === 0) {
    return { rouge1: 0, rougeL: 0, rouge1F: 0, rougeLF: 0, referenceTokens }
  }
  const base = { tokenizer: charTokens, caseSensitive: false }
  return {
    rouge1: rougeN(answer, reference, { ...base, n: 1, beta: ROUGE_RECALL_BETA }),
    rougeL: rougeL(answer, reference, { ...base, beta: ROUGE_RECALL_BETA }),
    rouge1F: rougeN(answer, reference, { ...base, n: 1 }),
    rougeLF: rougeL(answer, reference, base),
    referenceTokens,
  }
}
