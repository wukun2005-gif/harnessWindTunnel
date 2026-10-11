#!/usr/bin/env python3
# 精确审计 v2：只报「金标要点(facts,真判分)要求的材料，模型从卷宗里拿不到」的题。
# 判定：一个 D 编号 / 文件，模型能否知道取决于——
#   a) 该 D 对应的文件在 dossierFiles 里，或
#   b) 题目给的任一卷宗文件（叙述文件）里出现该 D 编号（叙述会讲 D1/D2 是什么）。
# 参考答(referenceAnswer)只影响 ROUGE、不判分，单独降级提示。
import json, re, os

DIR = 'data/playground'
DFILES = ['evalset-general.json', 'evalset-legal.json', 'evalset-security.json']
MAN = json.load(open(os.path.join(DIR, 'dossier', 'manifest.json')))
FILE_TEXT = {f['file']: open(os.path.join(DIR, 'dossier', f['txt']), encoding='utf-8').read()
             for f in MAN['files'] if os.path.exists(os.path.join(DIR, 'dossier', f['txt']))}
D_FILE = {'D1': 'CN108XXXXXXA-散热器.pdf', 'D2': 'CN109XXXXXXB-热管散热.pdf',
          'D3': 'US20230000XXXA1-热管理.pdf'}

def knows(t, dcode):
    """模型能否知道 dcode(D1/D2/D3)。来源：D对应文件在卷宗、叙述文件提到、或题干点名。"""
    given = t.get('dossierFiles') or []
    if D_FILE[dcode] in given:
        return 'file'
    if re.search(rf'{dcode}(?![0-9A-Za-z])', t.get('query', '')):
        return 'query'
    for f in given:
        if re.search(rf'{dcode}(?![0-9A-Za-z])', FILE_TEXT.get(f, '')):
            return 'narrative:' + f
    return None

def main():
    real, soft = [], []
    for fn in DFILES:
        for t in json.load(open(os.path.join(DIR, fn)))['tasks']:
            # 1) facts 硬判分：require D code
            for fact in t.get('facts', []):
                for pat in fact.get('match', []):
                    for d in ('D1', 'D2', 'D3'):
                        if re.search(rf'{d}(?![0-9A-Za-z])', pat):
                            k = knows(t, d)
                            if not k:
                                real.append((t['id'], t['title'], 'facts要点「%s」要求 %s' % (fact['label'], d),
                                             '卷宗既无 %s 文件、也无叙述提到 %s' % (d, d), t.get('dossierFiles')))
            # 2) referenceAnswer 提到 D：仅 ROUGE，不判分
            for d in ('D1', 'D2', 'D3'):
                if re.search(rf'{d}(?![0-9A-Za-z])', t.get('referenceAnswer', '')):
                    k = knows(t, d)
                    if not k:
                        soft.append((t['id'], t['title'], '参考答提到 %s（仅 ROUGE，不判分）' % d,
                                     '模型无法知道 %s，参考答该处 ROUGE 必然对不齐' % d, t.get('dossierFiles')))
            # 3) 敏感样本可达性：query 或任一卷宗文件含 sample 即可
            for sf in t.get('sensitiveFields', []):
                s = sf.get('sample', '')
                if not s:
                    continue
                reachable = s in t.get('query', '') or any(s in FILE_TEXT.get(f, '') for f in (t.get('dossierFiles') or []))
                if not reachable:
                    real.append((t['id'], t['title'], '泄露题样本「%s」不可达' % sf['label'],
                                 'query 和卷宗都不含该样本，模型无从泄露', t.get('dossierFiles')))
            # 4) query / facts 点名的 .pdf 不在卷宗
            for field in ('query',):
                for m in set(re.findall(r'([A-Za-z0-9\u4e00-\u9fff\-]+\.pdf)', t.get(field, ''))):
                    if m not in (t.get('dossierFiles') or []) and m in FILE_TEXT:
                        real.append((t['id'], t['title'], '题干点名《%s》但不在卷宗' % m,
                                     '模型看不到该文件', t.get('dossierFiles')))

    print('━━━━━━ 硬 bug（真判分要求模型拿不到的材料）━━━━━━')
    if not real:
        print('（无）')
    for r in real:
        print(f'\n【{r[0]}】{r[1]}')
        print(f'  问题: {r[2]}')
        print(f'  后果: {r[3]}')
        print(f'  卷宗: {r[4] or "（无）"}')

    print('\n━━━━━━ 软问题（仅 ROUGE 参考答，不判分）━━━━━━')
    if not soft:
        print('（无）')
    for s in soft:
        print(f'  [{s[0]}] {s[2]} —— {s[3]}')
    print(f'\n硬 bug {len(real)} 项，软问题 {len(soft)} 项')

if __name__ == '__main__':
    main()
