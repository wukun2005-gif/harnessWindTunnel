#!/usr/bin/env python3
"""
RAG sufficiency-judge model bake-off.

The RAG MCP asks one internal LLM "are these local law-library hits enough to
answer the question?" and only searches the web when the answer is no. That
judge must be reliable, cheap and fast — it sits in the hot path of every
`patent_law_search` call. This script ranks candidate judge models on a fixed
8-case set: 4 questions whose answer IS in the local KB (expect sufficient) and
4 whose answer is NOT (expect insufficient).

Run against the running server (local KB search goes through /api/knowledge/search):
  python3 scripts/eval-rag-judge-models.py [--prompt v2|v1]
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.path.join(ROOT, 'server-data', 'settings.json')
OUT = os.path.join(ROOT, 'server-data', 'batch270', 'rag-judge-bakeoff.json')
BASE = 'http://localhost:4000'

# Candidates: (label, providerId, model, why)
CANDIDATES = [
    ('deepseek-v4.1-flash', 'bailian', 'deepseek-v4.1-flash', 'chain #1 — 990K left, exp 12/13'),
    ('qwen3.8-max-0902', 'bailian', 'qwen3.8-max-0902', 'chain #2 — 991K left, exp 12/01'),
    ('qwen3.8-2.4t-a95b', 'bailian', 'qwen3.8-2.4t-a95b', 'chain #3 — 938K left, exp 11/12'),
]

PROMPT_V1 = '\n'.join([
    '你是检索充分性判定员。给定【问题】与【本地法库检索到的片段】，判断这些片段是否足以回答该问题。',
    '只输出一个 JSON 对象，不要输出其它任何文字：',
    '{"sufficient": true|false, "reason": "一句话理由", "webQuery": "若不足，给一条用于联网检索的查询式；足够则填空串"}',
    '判定标准：片段必须覆盖回答问题所需的法律条文 / 审查标准 / 事实。只沾边、或只覆盖问题的一部分，判 false。',
])

PROMPT_V2 = '\n'.join([
    '你是检索充分性判定员。给定【问题】与【本地法库检索到的片段】，判断这些片段是否足以回答该问题。',
    '判定标准（重要）：',
    '1) 只要片段覆盖了回答问题所需的要点（法律条文 / 审查标准 / 事实）就算充分——不要求逐字原文，释义、改写、部分引用都算。',
    '2) 片段与问题主题相关、但没有回答到问题所问的具体点时，判不充分。',
    '3) 只看片段内容，不要用你自己的法律知识替它补全。',
    '4) 必须用中文回答。',
    '只输出一个 JSON 对象，不要输出其它任何文字：',
    '{"sufficient": true|false, "reason": "一句话理由（中文）", "webQuery": "若不足，给一条用于联网检索的查询式；足够则填空串"}',
])

# Labels are verified against the ACTUAL top-5 local hits (not against "this law
# exists in the KB" — the judge only ever sees the retrieved top-5, so if
# retrieval misses the right article then "insufficient" is the CORRECT answer).
# Verified hit contents (see the dump in the session log):
#   1) 22条3款: hit#1 is 审查指南 3.1 quoting Art 22(3)'s substance → sufficient
#   2) 2条2款 : hits are 管辖/强制许可/创造性/天然物质 — no Art 2(2)  → insufficient
#   3) 26条4款: hit#1 states it verbatim                        → sufficient
#   4) 细则65条: hits are 70/71/72/75/76 + 司法解释第五条 — no Art 65 → insufficient
#   5-8) out-of-KB by construction                               → insufficient
CASES = [
    ('专利法第二十二条第三款关于创造性的规定原文', True),
    ('专利法第二条第二款 发明的定义', False),
    ('专利法第二十六条第四款 权利要求书以说明书为依据', True),
    ('专利法实施细则 第六十五条 无效宣告理由', False),
    ('创造性判断三步法在审查指南中的具体操作步骤与示例', False),
    ('2025年最新修订的专利审查指南新增条款编号清单', False),
    ('欧盟统一专利法院 UPC 2026 年最新判例', False),
    ('美国 AIA 第102条与中国专利法第22条第2款的逐项对比', False),
]


def settings():
    return json.load(open(SETTINGS, encoding='utf-8'))


def card(provider_id):
    for p in settings().get('provider_all', {}).get('providers', []):
        if p.get('providerId') == provider_id:
            return p
    return {}


def key_of(p):
    return (p.get('apiKeyRef') or p.get('apiKey') or '').strip()


def kb_hits(query, top_k=5):
    req = urllib.request.Request(
        BASE + '/api/knowledge/search',
        data=json.dumps({'query': query, 'topK': top_k}).encode(),
        headers={'Content-Type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=60) as r:
        body = json.load(r)
    return body.get('hits') or body.get('results') or []


def digest(hits):
    return '\n'.join(
        f"{i+1}. （{(h.get('metadata') or {}).get('name','')}）"
        f"{(h.get('text') or '')[:400].replace(chr(10), ' ')}"
        for i, h in enumerate(hits))


def ask(provider_id, model, system, user, max_tokens=512, no_think=False):
    p = card(provider_id)
    url = p['baseUrl'].rstrip('/') + '/chat/completions'
    body = {'model': model, 'temperature': 0, 'max_tokens': max_tokens,
            'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}]}
    # qwen3.8-max-0902 spends ~390 reasoning tokens on a ~30-token JSON verdict,
    # which is 4x the latency for no benefit. Bailian honours enable_thinking.
    if no_think:
        body['enable_thinking'] = False
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(),
        headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key_of(p)},
        method='POST')
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.load(r)
    ms = int((time.time() - t0) * 1000)
    text = (j.get('choices') or [{}])[0].get('message', {}).get('content') or ''
    a, b = text.find('{'), text.rfind('}')
    verdict = None
    if a >= 0 and b > a:
        try:
            v = json.loads(text[a:b + 1])
            if isinstance(v.get('sufficient'), bool):
                verdict = v
        except Exception:
            verdict = None
    return verdict, ms, (j.get('usage') or {}), text


def main():
    prompt = PROMPT_V2
    if '--prompt' in sys.argv:
        prompt = PROMPT_V1 if sys.argv[sys.argv.index('--prompt') + 1] == 'v1' else PROMPT_V2
    no_think = '--no-think' in sys.argv
    print(f'prompt={ "v1" if prompt is PROMPT_V1 else "v2" }  no_think={no_think}', flush=True)

    print('fetching local KB hits for the 8 cases …', flush=True)
    ctx = []
    for q, expect in CASES:
        hits = kb_hits(q)
        ctx.append({'q': q, 'expect': expect, 'hits': hits, 'digest': digest(hits)})
        print(f'  {len(hits)} hits | {q[:36]}', flush=True)

    results = {}
    for label, pid, model, why in CANDIDATES:
        rows = []
        for c in ctx:
            user = f"【问题】\n{c['q']}\n\n【本地片段】\n{c['digest']}"
            try:
                v, ms, usage, raw = ask(pid, model, prompt, user, no_think=no_think)
            except Exception as e:
                v, ms, usage, raw = None, -1, {}, f'ERR {type(e).__name__}: {str(e)[:80]}'
            got = None if not v else v['sufficient']
            rows.append({'q': c['q'], 'expect': c['expect'], 'got': got,
                         'ok': got == c['expect'], 'ms': ms,
                         'tok': usage.get('total_tokens'),
                         'reason': (v or {}).get('reason', '')[:110],
                         'raw': None if v else raw[:120]})
        acc = sum(1 for r in rows if r['ok'])
        parse = sum(1 for r in rows if r['got'] is not None)
        toks = [r['tok'] for r in rows if r['tok']]
        mss = [r['ms'] for r in rows if r['ms'] > 0]
        print(f"\n=== {label} ({model}) — {why}", flush=True)
        print(f"    准确率 {acc}/{len(rows)} | JSON可解析 {parse}/{len(rows)} | "
              f"均token {sum(toks)//len(toks) if toks else 0} | 均延迟 {sum(mss)//len(mss) if mss else 0}ms", flush=True)
        for r in rows:
            flag = 'OK ' if r['ok'] else 'BAD'
            print(f"    [{flag}] expect={r['expect']} got={r['got']} {r['ms']}ms | {r['q'][:30]} | {r['reason'][:70]}", flush=True)
        results[label] = {'model': model, 'provider': pid, 'why': why,
                          'acc': acc, 'parse': parse, 'rows': rows}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(results, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print(f'\nwritten {OUT}', flush=True)
    print('\n=== RANKING (acc desc, parse desc, latency asc) ===', flush=True)
    for label, r in sorted(results.items(), key=lambda kv: (-kv[1]['acc'], -kv[1]['parse'])):
        mss = [x['ms'] for x in r['rows'] if x['ms'] > 0]
        print(f"  {r['acc']}/8 acc, {r['parse']}/8 parse, "
              f"{sum(mss)//len(mss) if mss else 0}ms  {label}", flush=True)


if __name__ == '__main__':
    main()
