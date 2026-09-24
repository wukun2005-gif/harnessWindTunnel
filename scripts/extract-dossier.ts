// M1: extract the led-heatsink dossier PDFs (sibling patentExaminator sample)
// into plain text under data/playground/dossier/, plus a manifest with hashes.
// Idempotent: re-running overwrites outputs and refreshes the manifest.
//
//   DOSSIER_SRC=/path/to/led-heatsink npx tsx scripts/extract-dossier.ts
//
// Default source is ../patentExaminator/samples/led-heatsink next to this repo.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
import { extractText } from '../server/knowledge/extract'

const root = process.cwd()
const src = process.env['DOSSIER_SRC']
  ? resolve(process.env['DOSSIER_SRC'] as string)
  : resolve(root, '..', 'patentExaminator', 'samples', 'led-heatsink')
const outDir = resolve(root, 'data', 'playground', 'dossier')

async function main() {
  mkdirSync(outDir, { recursive: true })
  const files = readdirSync(src).filter((f) => f.toLowerCase().endsWith('.pdf')).sort()
  const manifest: Array<{ file: string; txt: string; chars: number; sha256: string }> = []
  for (const f of files) {
    const buf = readFileSync(join(src, f))
    const { text } = await extractText(buf, f)
    const txtName = f.replace(/\.pdf$/i, '.txt')
    writeFileSync(join(outDir, txtName), text, 'utf8')
    const sha256 = createHash('sha256').update(buf).digest('hex')
    manifest.push({ file: f, txt: txtName, chars: text.length, sha256 })
    console.log(`${f}: ${text.length} chars`)
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ sourceDir: src, files: manifest }, null, 2), 'utf8')
  console.log(`\n${files.length} dossier files -> ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
