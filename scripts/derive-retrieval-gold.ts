// P1-E 金标重打：全部走应引法条派生（文本直连作废：多指向总则 preamble，与题无关）。
// 每题的 refs 为评估集 expectedArticles 人工转写（law key 见 articles.ts LAW_ALIASES）。
// 另加 c3ef81bf 的费用 chunk（指南 2.5＋细则 110，题面问期限加费用，已核验）。
// 用法：npx tsx scripts/derive-retrieval-gold.ts（幂等：全量重写 gold）。
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { locateArticle } from '../server/playground/articles'

function norm(s: string): string {
  return s
    .replace(/[\s　]+/g, '')
    .replace(/[，,、；;：:。．“”"''「」（）()【】\[\]·•\-—_～~]/g, '')
    .toLowerCase()
}

type Ref = { law: string; article?: string; section?: string }
const REFS: Record<string, Ref[]> = {
  'gs-aeabccf9': [{ law: 'patent-law', article: '22' }],
  'gs-1f9d0a96': [{ law: 'patent-law', article: '26' }],
  'gs-c3ef81bf': [{ law: 'patent-law', article: '41' }],
  'gs-cf7f8262': [{ law: 'patent-law', article: '26' }, { law: 'patent-law', article: '22' }],
  'gs-85bce382': [{ law: 'patent-law', article: '22' }],
  'gs-e6b9434b': [{ law: 'guideline', section: '第二部分第四章3.2.1.1' }],
  'gs-74892da0': [{ law: 'implementing-regulations', article: '6' }],
  'gs-ecad68be': [{ law: 'guideline', section: '第二部分第二章3.2.1' }, { law: 'patent-law', article: '26' }],
  'gs-5369d1f4': [{ law: 'patent-law', article: '24' }, { law: 'patent-law', article: '22' }],
  'gs-49517926': [{ law: 'patent-law', article: '26' }, { law: 'patent-law', article: '33' }],
  'gs-f9a69c8e': [{ law: 'guideline', section: '第二部分第四章3.2.1.1' }, { law: 'guideline', section: '第二部分第四章3.2.1.2' }],
  'gs-9e054028': [{ law: 'patent-law', article: '2' }],
  'gs-0ccd23cf': [{ law: 'patent-law', article: '22' }],
  'gs-25088263': [{ law: 'patent-law', article: '26' }],
  'gs-f9710e85': [{ law: 'patent-law', article: '22' }],
  'gs-e74c0a64': [{ law: 'patent-law', article: '3' }],
  'gs-a54bba9a': [{ law: 'patent-law', article: '2' }],
}
// 题面问期限加费用，法条派生之外的已核验费用 chunk（指南 2.5＋细则 110）。
const EXTRA_CHUNKS: Record<string, string[]> = {
  'gs-c3ef81bf': ['ks-1789916611792-eat57g-c549', 'ks-1789916682353-21hl5r-c88'],
}

const db = new DatabaseSync('server-data/knowledge.db')
const chunks = db.prepare('SELECT id, text FROM kb_chunks').all() as Array<{ id: string; text: string }>
const nchunks = chunks.map((c) => ({ id: c.id, ntext: norm(c.text) }))

const file = 'data/playground/evalset-retrieval-pairs.json'
const doc = JSON.parse(readFileSync(file, 'utf8')) as {
  pairs: Array<{ queryId: string; newChunkIds: string[]; goldSource?: string; goldConfidence?: string }>
}

for (const p of doc.pairs) {
  const refs = REFS[p.queryId]
  if (!refs) {
    console.log(`${p.queryId}: no refs, skipped`);
    continue
  }
  const hits = new Set<string>()
  for (const ref of refs) {
    const located = locateArticle(ref)
    if (!located) {
      console.log(`${p.queryId}: article MISS`, JSON.stringify(ref))
      continue
    }
    const ntext = norm(located.text)
    for (const c of nchunks) {
      if (c.ntext.length > 20 && (ntext.includes(c.ntext) || c.ntext.includes(ntext))) hits.add(c.id)
    }
  }
  for (const extra of EXTRA_CHUNKS[p.queryId] ?? []) hits.add(extra)
  p.newChunkIds = [...hits].sort()
  p.goldSource = 'article-derived'
  p.goldConfidence = p.newChunkIds.length > 0 ? 'solid' : 'thin'
  console.log(`${p.queryId}: ${p.newChunkIds.length} chunks`)
}

writeFileSync(file, JSON.stringify(doc, null, 2))
console.log('done')
