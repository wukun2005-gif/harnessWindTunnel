/**
 * 文本预处理流水线 — 清洗、规范化、噪声/乱码检测、文档分类
 * Verbatim port from patentExaminator server/src/routes/knowledge.ts
 * (cleanText / normalizeLegalReference / normalizeDate / normalizeWidth /
 *  normalizeTraditional / isNoise / isGarbled / classifyDocument).
 */

/** 清洗：去页眉页脚、水印、多余空白 */
export function cleanText(text: string): string {
  let cleaned = text
  cleaned = cleaned.replace(/^第\s*\d+\s*页.*$/gm, '')
  cleaned = cleaned.replace(/^-\s*\d+\s*-$/gm, '')
  cleaned = cleaned.replace(/^\d+\s*\/\s*\d+$/gm, '')
  cleaned = cleaned.replace(/^(仅供|内部|草稿|DRAFT|CONFIDENTIAL).{0,20}$/gim, '')
  cleaned = cleaned.replace(/[ \t]+/g, ' ')
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n')
  cleaned = cleaned.replace(/^\s+$/gm, '')
  return cleaned.trim()
}

/**
 * 中日韩字间空白归一化：PDF 文本层常在汉字之间塞入空格或换行（逐字定位/分页产物），
 * 会把 jieba 切碎、BM25 降权。只处理两种断词：
 * 1. 横向空白（空格/制表/全角空格）在两汉字之间 → 删；
 * 2. 换行在两汉字之间、且前字不是句末标点 → 接上（段落换行保留）。
 * 数字/拉丁周围的空格、句末标点后的换行原样保留。
 */
const SENTENCE_END = '。！？；：」’”'
export function normalizeCjkSpacing(text: string): string {
  const noSpaces = text.replace(/(?<=[\u4e00-\u9fff])[ \t　]+(?=[\u4e00-\u9fff])/g, '')
  return noSpaces.replace(/([\u4e00-\u9fff])[ \t　]*[\r\n]+[ \t　]*([\u4e00-\u9fff])/g, (m, a: string, b: string) =>
    SENTENCE_END.includes(a) ? m : a + b,
  )
}

/** 法条引用规范化 */function normalizeLegalReference(text: string): string {
  let n = text
  n = n.replace(/§(\d+)\.(\d+)/g, '第$1条第$2款')
  n = n.replace(/§(\d+)/g, '第$1条')
  n = n.replace(/Article\s+(\d+)/gi, '第$1条')
  return n
}

/** 日期规范化 */
function normalizeDate(text: string): string {
  let n = text
  n = n.replace(/(\d{4})年(\d{1,2})月(\d{1,2})日/g, (_, y: string, m: string, d: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
  n = n.replace(/(\d{4})\.(\d{1,2})\.(\d{1,2})/g, (_, y: string, m: string, d: string) => `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`)
  return n
}

/** 全角转半角 */
function normalizeWidth(text: string): string {
  return text.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

/** 繁简转换（常用字映射，覆盖专利法律领域常见字） */
const TRADITIONAL_MAP: Record<string, string> = {
  專: '专', 權: '权', 請: '请', 發: '发', 審: '审',
  標: '标', 準: '准', 術: '术', 證: '证', 據: '据',
  議: '议', 論: '论', 題: '题', 實: '实', 義: '义', 務: '务',
  處: '处', 報: '报', 關: '关', 開: '开', 問: '问', 間: '间',
  書: '书', 記: '记', 設: '设', 計: '计', 資: '资', 運: '运',
  過: '过', 達: '达', 進: '进', 選: '选', 還: '还', 適: '适',
  類: '类', 點: '点', 號: '号', 統: '统', 續: '续', 維: '维',
  組: '组', 結: '结', 絕: '绝', 總: '总', 經: '经', 網: '网',
  規: '规', 認: '认', 護: '护', 質: '质', 輸: '输', 轉: '转',
  載: '载', 銷: '销', 鏈: '链', 閱: '阅', 雲: '云',
  電: '电', 響: '响', 預: '预', 驗: '验', 體: '体', 優: '优',
}

function normalizeTraditional(text: string): string {
  return text.replace(/[一-鿿]/g, (ch) => TRADITIONAL_MAP[ch] ?? ch)
}

/** 完整预处理流水线 */
export function preprocessText(text: string): string {
  let result = text
  result = cleanText(result) // 去页眉页脚水印
  result = normalizeCjkSpacing(result) // 汉字间 PDF 空格
  result = normalizeLegalReference(result) // 法条引用规范化
  result = normalizeDate(result) // 日期规范化
  result = normalizeWidth(result) // 全角转半角
  result = normalizeTraditional(result) // 繁简转换
  return result
}

/** 文档类型推断 */
export function classifyDocument(fileName: string, text: string): string {
  const lower = fileName.toLowerCase()
  const head = text.slice(0, 500)
  if (lower.includes('审查指南') || head.includes('专利审查指南')) return '审查指南'
  if (lower.includes('司法解释') || head.includes('最高人民法院')) return '司法解释'
  if (lower.includes('专利法实施细则') || head.includes('国务院令')) return '行政法规'
  if (lower.includes('专利法') || head.includes('全国人民代表大会')) return '法律'
  if (lower.includes('案例') || lower.includes('决定要点')) return '案例'
  return '其他'
}

/**
 * 目录行：序号开头 + 标题文字 + 点连线（4 个以上点/中点/省略号/空白）+ 末尾页码。
 * 例："13. 新颖性判断中单独对比原则的理解 .................. 11"
 * 正文不会出现点连线后接孤立页码的排版，故为确定性安全规则。
 */
const TOC_LINE_RE =
  /^\s*(?:\d{1,3}(?:\.\d{1,3})*[.、]?\s+|[(（][一二三四五六七八九十百千\d]+[)）]\s*)\S[\s\S]{0,90}?[.．·…\s]{4,}\d{1,4}\s*$/

/** 目录条目 chunk：单条目录行，或目录页（目录行占非空行 ≥ 一半） */
export function isTocChunk(text: string): boolean {
  const lines = text
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length === 0) return false
  const tocLines = lines.filter((l) => TOC_LINE_RE.test(l))
  if (tocLines.length === 0) return false
  return lines.length === 1 || tocLines.length / lines.length >= 0.5
}

/** 噪声检测 */
export function isNoise(text: string): boolean {
  const t = text.trim()
  if (t.length === 0) return true
  if (/^[\d\s]+$/.test(t)) return true
  if (/^[^\w一-鿿]+$/.test(t)) return true
  if (t.length < 5 && !/[一-鿿]/.test(t)) return true
  if (isTocChunk(t)) return true
  return false
}

/** 乱码检测：有意义字符占比低于 30% 视为乱码 */
export function isGarbled(text: string): boolean {
  const meaningful = text.match(/[\w一-鿿]/g)
  const ratio = meaningful ? meaningful.length / text.length : 0
  return ratio < 0.3
}
