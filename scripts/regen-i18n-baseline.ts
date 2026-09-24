// 重新生成 scripts/fixtures/i18n-zh-baseline.json（zh/fixtureZh 的冻结快照）。
// 用法：npx tsx scripts/regen-i18n-baseline.ts —— 任何有意的中文文案增改后运行，i18n.test.ts 会校验一致性。
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const source = readFileSync(resolve('src/i18n.ts'), 'utf8')
const ast = ts.createSourceFile('i18n.ts', source, ts.ScriptTarget.Latest, true)
const dicts: Record<string, Record<string, string>> = {}
ast.forEachChild((node) => {
  if (!ts.isVariableStatement(node)) return
  for (const declaration of node.declarationList.declarations) {
    const name = declaration.name.getText(ast)
    if (!['en', 'zh', 'fixtureEn', 'fixtureZh'].includes(name)) continue
    dicts[name] = {}
    for (const prop of (declaration.initializer as ts.ObjectLiteralExpression).properties) {
      const p = prop as ts.PropertyAssignment
      const key = (p.name as ts.StringLiteral).text
      if (key in dicts[name]) throw new Error(`duplicate key in ${name}: ${key}`)
      dicts[name][key] = (p.initializer as ts.StringLiteral).text
    }
  }
})

const sha = (o: Record<string, string>) => createHash('sha256').update(JSON.stringify(o)).digest('hex')
const zh = dicts.zh!
const fixtureZh = dicts.fixtureZh!
const header = [
  '// Frozen snapshot of the Chinese dictionaries (zh + fixtureZh).',
  '// Used by scripts/i18n.test.ts: any intentional Chinese copy change must',
  '// regenerate this file; unintentional drift fails the test.',
  `// zh: ${Object.keys(zh).length} keys, sha256 ${sha(zh)}`,
  `// fixtureZh: ${Object.keys(fixtureZh).length} keys, sha256 ${sha(fixtureZh)}`,
].join('\n')
writeFileSync(resolve('scripts/fixtures/i18n-zh-baseline.json'), `${header}\n${JSON.stringify({ zh, fixtureZh }, null, 2)}\n`)
console.log(`zh ${Object.keys(zh).length} keys sha=${sha(zh)} · fixtureZh ${Object.keys(fixtureZh).length} keys sha=${sha(fixtureZh)}`)
