#!/usr/bin/env python3
"""分析页签同口径分析 P1-C 失败标签批次：一致率 / 来源 / 漂移 / 校准桶 / 门限。
用法: python3 scripts/analyze-tags.py <batchId>
口径: 一致率分母=可比行(consistent+divergent)，弃权(incomparable)不进分母；另报全量口径。
校准 eff = min(jev置信, 回落读数置信若存在)；仅可比行进桶。漂移按 (taskId,kind) 3 读分组。
"""
import json, sys, collections

BATCH = sys.argv[1] if len(sys.argv) > 1 else None
if not BATCH:
    print("usage: analyze-tags.py <batchId>")
    sys.exit(1)

rows = [json.loads(l) for l in open("server-data/jev-reviews.jsonl") if l.strip()]
rows = [r for r in rows if r.get("batchId") == BATCH]
if not rows:
    print(f"no records for batch {BATCH}")
    sys.exit(1)

print(f"== 批次 {BATCH} · {len(rows)} 条 ==")

# ── 一致率（可比分母）＋全量口径 ──
cons = collections.Counter(r["result"].get("consistency") for r in rows)
c, d, inc = cons.get("consistent", 0), cons.get("divergent", 0), cons.get("incomparable", 0)
comp = c + d
print(f"一致率: {c}/{comp} = {c/comp:.1%}  (可比; 弃权不可比 {inc} 条不进分母)" if comp else "一致率: n/a")
print(f"全量口径: {c}/{len(rows)} = {c/len(rows):.1%}")
print(f"门限 80%: {'过' if comp and c/comp >= 0.8 else '不过'}")

# ── 分域 ──
print("\n-- 分域 --")
bydom = collections.defaultdict(lambda: [0, 0, 0])
for r in rows:
    k = r.get("domain") or "?"
    s = r["result"].get("consistency")
    if s == "consistent":
        bydom[k][0] += 1
    elif s == "divergent":
        bydom[k][1] += 1
    else:
        bydom[k][2] += 1
for k in sorted(bydom):
    cc, dd, ii = bydom[k]
    tot = cc + dd
    rate = f"{cc}/{tot} = {cc/tot:.0%}" if tot else "全弃权"
    print(f"  {k}: {rate} (弃权 {ii})")

# ── 来源 ──
print("\n-- 来源 --")
src = collections.Counter(r["result"].get("source") for r in rows)
for k in sorted(src, key=lambda x: -src[x]):
    print(f"  {k}: {src[k]}")
jmodels = collections.Counter(
    r["result"].get("chatJudge", {}).get("model")
    for r in rows
    if r["result"].get("source") == "llm-judge"
)
if jmodels:
    print("  回落判定模型:", dict(jmodels))

# ── 交人原因分类 ──
nh = [r for r in rows if r["result"].get("source") == "needs-human"]
if nh:
    print(f"\n-- 交人 {len(nh)} 条的原因 --")
    cat = collections.Counter()
    for r in nh:
        reason = r["result"].get("reason") or ""
        if "无法判断" in reason:
            cat["弃权 unclear（按设计交人）"] += 1
        elif "JSON" in reason or "可解析" in reason:
            cat["回落解析失败（P0 盲区）"] += 1
        elif "回落" in reason:
            cat["回落其它失败"] += 1
        elif "阈值" in reason:
            cat["低置信且关回落/无模型"] += 1
        else:
            cat["其它: " + reason[:40]] += 1
    for k, v in cat.most_common():
        print(f"  {k}: {v}")

# ── 漂移（(taskId,kind) 3 读分组）──
print("\n-- 漂移 --")
groups = collections.defaultdict(list)
for r in rows:
    groups[(r.get("taskId"), r.get("kind"))].append(
        r["result"].get("choice", {}).get("choice") if r["result"].get("choice") else None
    )
drift = [k for k, v in groups.items() if len(set(map(str, v))) > 1]
print(f"漂移样品 {len(drift)}/{len(groups)} = {len(drift)/len(groups):.1%}  (门限 5%: {'过' if len(drift)/len(groups) <= 0.05 else '不过'})")
for k in sorted(drift, key=str):
    print(f"  {k}: {groups[k]}")

# ── 校准桶（可比行；eff = min(jev置信, 回落置信)）──
print("\n-- 校准桶（可比行, 实际置信 = min(Jev, 回落)）--")
buckets = {"0-70": [0, 0], "70-80": [0, 0], "80-90": [0, 0], "90-100": [0, 0]}
for r in rows:
    if r["result"].get("consistency") not in ("consistent", "divergent"):
        continue
    ch = r["result"].get("choice")
    if not ch:
        continue
    eff = ch.get("confidence")
    cj = r["result"].get("chatJudge")
    if cj and cj.get("confidence") is not None and eff is not None:
        eff = min(eff, cj["confidence"])
    if eff is None:
        continue
    effp = eff * 100
    k = "0-70" if effp < 70 else "70-80" if effp < 80 else "80-90" if effp < 90 else "90-100"
    buckets[k][0] += 1
    buckets[k][1] += 1 if r["result"].get("consistency") == "consistent" else 0
for k in ["0-70", "70-80", "80-90", "90-100"]:
    n, ok = buckets[k]
    if n:
        print(f"  {k}: {ok}/{n} = {ok/n:.0%}")
g80 = buckets["80-90"]
g90 = buckets["90-100"]
gate80 = (g80[1] / g80[0] >= 0.70) if g80[0] else True
gate90 = (g90[1] / g90[0] >= 0.80) if g90[0] else True
print(f"校准双门 (80-90≥70%, 90-100≥80%): {'过' if gate80 and gate90 else '不过'}")

# ── 分歧明细 ──
divs = [r for r in rows if r["result"].get("consistency") == "divergent"]
if divs:
    print(f"\n-- 分歧 {len(divs)} 条 --")
    for r in divs:
        ch = r["result"].get("choice", {}).get("choice")
        gold = r.get("gold")
        gold_txt = "、".join(gold) if isinstance(gold, list) else gold
        srcv = r["result"].get("source")
        print(f"  {r.get('taskId')} {r.get('kind')}: Jev判「{ch}」vs 金标「{gold_txt}」 ({srcv})")
