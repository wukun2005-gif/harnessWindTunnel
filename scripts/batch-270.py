#!/usr/bin/env python3
"""
Full-test batch driver: 45 tasks x {C0, domain preset} x 3 reps = 270 live runs.

Design constraints (why it is shaped like this):
  - The server caps concurrency (runner.ts CONCURRENCY=2) and each run is
    internally sequential, so at most 2 outbound requests exist at once. This
    driver does NOT add its own concurrency gate; it only keeps the server queue
    shallow so a rate limit never swallows a big backlog.
  - OpenRouter free models share ONE account quota across BOTH the answer model
    and the judge model: ~20 req/min and 1000 req/day. Depth<=4 keeps us far from
    the per-minute limit, but the DAILY limit is the real ceiling, so we watch
    /auth/key's free_model_daily_requests.remaining and stop enqueuing before it
    runs out, then resume automatically after the daily reset.
  - Progress lives in a state file, so killing/restarting (or waiting out a quota
    reset) resumes exactly where it stopped.

Every finished run is validated. An invalid run is KEPT (so the failure stays
reviewable) and a fresh run is enqueued in its place; only a run that passes
validation counts as "accepted". A run is invalid when any of these hold:
  * status is not `scored`, or the run carries an error
  * the answering model is not the expected one (fallback would mix model
    differences into a harness comparison)
  * the answer is empty, whitespace, or one of the runner's no-answer placeholders
  * the deterministic verdict or its ROUGE reading is missing
  * the decision reading is missing, errored (`source=error/off`), abstained
    (no `choice`), or produced no verdict (`success` is null)

Scoring model (2026-10-12 refactor): the four old judges are gone. Pass/fail and
score come only from the decision model configured on the decision card; the
deterministic checks (ROUGE / fact hits / article checks / sensitive-field leaks /
failure tags) stay in the run detail as evidence and failure attribution, and its
law conclusions are fed into the decision model as material.

Usage:
  python3 scripts/batch-270.py --check     # plan + quota + expected models
  python3 scripts/batch-270.py --report    # current state summary
  python3 scripts/batch-270.py --rejects   # list every rejected run (audit)
  python3 scripts/batch-270.py             # run the batch (resumable, long-running)
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.path.join(ROOT, 'server-data', 'settings.json')
STATE_DIR = os.path.join(ROOT, 'server-data', 'batch270')
STATE = os.path.join(STATE_DIR, 'state.json')
LOG = os.path.join(STATE_DIR, 'run.log')

BASE = 'http://localhost:4000'
# Variant: `--c2web` re-runs ONLY the legal C2 units (21 tasks × 3 reps = 63)
# after the RAG MCP gained its sufficiency-gated web augmentation, so the
# C2-with-web harness can be compared against the C2-without-web runs that the
# main batch already produced. Separate state/log so neither clobbers the other.
VARIANT = 'c2web' if '--c2web' in sys.argv else 'main'
STATE = os.path.join(STATE_DIR, 'state-c2web.json' if VARIANT == 'c2web' else 'state.json')
LOG = os.path.join(STATE_DIR, 'run-c2web.log' if VARIANT == 'c2web' else 'run.log')
DOMAIN_PRESET = {'general': 'C1', 'legal': 'C2', 'security': 'C3'}
DOMAIN_ORDER = ['general', 'legal', 'security']
REPS = 3
DEPTH = 4             # target server queue depth (queued + running) for OUR units
# Run the free tier to exhaustion. 0 means this guard never fires on an
# ESTIMATE of remaining quota; the batch instead pauses on the REAL rate-limit
# error from OpenRouter (see RATE_LIMIT_RE below) — the user's explicit rule:
# "run the free quota to 0 and stop when OpenRouter actually reports a rate
# limit", rather than stopping early on a self-imposed margin.
QUOTA_MARGIN = 0
# A free-tier rate-limit error is a "come back after the reset" signal, NOT a
# run failure: the run never got a fair chance, so it must not burn an attempt
# (otherwise the last units get marked failed forever instead of resuming).
RATE_LIMIT_RE = re.compile(r'429|rate.?limit|too many requests|quota', re.I)
RESUME_ABOVE = 200    # treat quota as reset when remaining climbs back above this
POLL_SEC = 12
QUOTA_POLL_SEC = 60
MAX_ATTEMPTS = 3      # per unit; a third rejection is recorded as failed
MIN_ANSWER_CHARS = 20
PLACEHOLDER_PREFIX = '（模型'   # runner's three no-answer placeholders all start here
# Decision cards, in the order the app arranges them (shared/jev.ts JEV_PROVIDER_IDS
# is the fixed pick order, but the stored card order is what resolveJevTargets()
# actually walks). The first enabled one is the expected scorer.
DECISION_CARD_ORDER = ['openrouter-jev', 'typesafe', 'opencode-jev']

# Tasks whose answers overflow the runner's 8192-token default output cap and
# come back as a no-answer placeholder. The generation model allows far more
# (235k completion tokens), so raise the ceiling for exactly these tasks only.
MAX_TOKENS_OVERRIDE = {'G10': 32768, 'L7': 32768, 'L11': 32768}


def max_tokens_for(task_id):
    """Per-task output ceiling; None means "let the runner use its default"."""
    return MAX_TOKENS_OVERRIDE.get(task_id)


def log(msg):
    line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def http_get(path, timeout=30):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.load(r)


def http_post(path, obj, timeout=60):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(obj).encode(),
        headers={'Content-Type': 'application/json'}, method='POST',
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def http_delete(path, timeout=30):
    req = urllib.request.Request(BASE + path, method='DELETE')
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def read_settings():
    try:
        return json.load(open(SETTINGS, encoding='utf-8'))
    except Exception:
        return {}


def _model_family(model):
    """`inception/mercury-decide-20260930` → `inception`: 带日期后缀的应答别名
    与卡上配的 `inception/mercury-decide:free` 同属一家。"""
    return (model or '').strip().split('/')[0].split(':')[0].lower()


def _card(settings, provider_id):
    for p in settings.get('provider_all', {}).get('providers', []):
        if p.get('providerId') == provider_id:
            return p
    return {}


def expected_models():
    """(answer model, decision model) — read from the app's own provider cards.

    Answer = the first usable chat card's default model (what the runner picks
    when the request carries no providerId). Decision = the first *enabled*
    decision card's default model, i.e. what resolveJevTargets() puts first
    server-side — since 2026-10-12 it is the only scorer, so there is no
    separate "judge LLM" any more.
    """
    s = read_settings()
    gen = (_card(s, 'openrouter').get('defaultModelId') or '').strip()
    judge = ''
    for pid in DECISION_CARD_ORDER:
        card = _card(s, pid)
        if not card or card.get('enabled') is False:
            continue
        m = (card.get('defaultModelId') or '').strip()
        if m:
            judge = m
            break
    return gen, judge


def openrouter_key():
    s = read_settings()
    k = (_card(s, 'openrouter').get('apiKeyRef') or _card(s, 'openrouter').get('apiKey') or '').strip()
    if k:
        return k
    leg = s.get('provider_openrouter') or {}
    return (leg.get('apiKeyRef') or leg.get('apiKey') or '').strip()


def quota_remaining():
    key = openrouter_key()
    if not key:
        return None
    req = urllib.request.Request('https://openrouter.ai/api/v1/auth/key',
                                 headers={'Authorization': 'Bearer ' + key})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            d = json.load(r)
        fm = (d.get('data') or {}).get('free_model_daily_requests') or {}
        return fm.get('remaining')
    except Exception as e:
        log(f'quota check failed: {type(e).__name__} {e}')
        return None


def build_plan():
    """Rep-major order: every unit's rep 1 first, then 2, then 3.

    Breadth-first on reps means that if the daily quota runs out mid-batch we
    still hold at least one complete pass over all 45 tasks, which is far more
    useful than 3 reps of the first third of the questions.
    """
    tasks = http_get('/api/playground/tasks')['tasks']
    by_domain = {}
    for t in tasks:
        by_domain.setdefault(t['domain'], []).append(t['id'])
    units = []
    for rep in range(1, REPS + 1):
        for dom in DOMAIN_ORDER:
            for tid in by_domain.get(dom, []):
                for preset in ['C0', DOMAIN_PRESET[dom]]:
                    if VARIANT == 'c2web' and preset != 'C2':
                        continue
                    units.append({
                        'taskId': tid, 'domain': dom, 'presetId': preset, 'rep': rep,
                        'runId': None, 'status': 'pending', 'attempts': 0, 'rejects': [],
                    })
    return units


def load_state():
    os.makedirs(STATE_DIR, exist_ok=True)
    if os.path.exists(STATE):
        st = json.load(open(STATE, encoding='utf-8'))
        if st.get('units'):
            return st
    st = {'createdAt': datetime.now(timezone.utc).isoformat(), 'units': build_plan()}
    save_state(st)
    return st


def save_state(st):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE)


def validate(detail, gen_model, judge_model):
    """Return a list of problems; empty list means the run is accepted."""
    p = []
    if detail.get('status') != 'scored':
        p.append(f"status={detail.get('status')}")
    if detail.get('error'):
        p.append(f"run-error: {str(detail['error'])[:120]}")
    model = (detail.get('provider') or {}).get('model') or detail.get('model')
    if gen_model and model != gen_model:
        p.append(f"answer-model={model} (expected {gen_model})")
    ans = (detail.get('answer') or '')
    if not ans.strip():
        p.append('empty-answer')
    elif ans.lstrip().startswith(PLACEHOLDER_PREFIX):
        p.append(f"placeholder-answer: {ans[:60]}")
    elif len(ans.strip()) < MIN_ANSWER_CHARS:
        p.append(f'answer-too-short ({len(ans.strip())})')
    v = detail.get('verdict') or {}
    if not v:
        p.append('no-verdict')
    elif not v.get('rouge'):
        p.append('no-rouge')
    jv = detail.get('jevResult')
    if not jv:
        p.append('no-jev')
    else:
        if jv.get('source') != 'decided':
            # 未启用 / 调用失败：run 会以 status=error 收尾并从分母剔除，这里照样记一条。
            p.append(f"jev-source={jv.get('source')}: {str(jv.get('reason'))[:80]}")
        if jv.get('error'):
            p.append(f"jev-error: {str(jv['error'])[:100]}")
        if not jv.get('choice'):
            p.append('jev-no-choice (abstain)')
        if jv.get('success') is None:
            p.append('jev-no-verdict')
        # 判定模型只校验厂商（inception/mercury-decide:free 应答回来是带日期后缀的
        # 别名 inception/mercury-decide-20260930，逐字相等会误杀）；判定卡之间的
        # 回退是合法行为，所以只拦「答的不是同一家」这类真错配。
        got = (jv.get('model') or '').strip()
        if judge_model and got and _model_family(got) != _model_family(judge_model):
            p.append(f"judge-model={got} (expected family {judge_model})")
    # C2+web only: the RAG sufficiency judge is PINNED to one model and must not
    # be swapped, so a judge failure cannot be papered over — every
    # patent_law_search call has to have produced a sufficiency verdict. A run
    # that searched without one is rejected and re-run (user's choice "a").
    if VARIANT == 'c2web':
        evs = detail.get('events') or []
        searches = sum(1 for e in evs
                       if e.get('type') == 'tool.call' and e.get('tool') == 'patent_law_search')
        suffs = sum(1 for e in evs
                    if e.get('type') == 'hook.decision' and e.get('hook') == 'rag-sufficiency')
        if suffs < searches:
            p.append(f'rag-judge-failed: {suffs}/{searches} searches got a sufficiency verdict')
    return p


def counts(st):
    c = {}
    for u in st['units']:
        c[u['status']] = c.get(u['status'], 0) + 1
    return c


def report(st):
    c = counts(st)
    total = len(st['units'])
    print(f'state={STATE}')
    print('units:', total, dict(c))
    rej = sum(1 for u in st['units'] if u.get('rejects'))
    print('units with >=1 rejection:', rej)
    for u in st['units']:
        if u.get('rejects'):
            print(' ', u['taskId'], u['presetId'], 'rep', u['rep'], '->', u['rejects'])


def main():
    gen_model, judge_model = expected_models()

    if '--check' in sys.argv:
        tasks = http_get('/api/playground/tasks')['tasks']
        by = {}
        for t in tasks:
            by.setdefault(t['domain'], []).append(t['id'])
        n = 0
        for dom in DOMAIN_ORDER:
            k = len(by.get(dom, []))
            print(f'{dom:9s} {k:2d} tasks x 2 configs (C0 + {DOMAIN_PRESET[dom]}) x {REPS} reps = {k * 2 * REPS}')
            n += k * 2 * REPS
        print(f'total = {n} runs')
        print('expected answer model =', gen_model)
        print('expected judge  model =', judge_model)
        print('maxTokens overrides =', MAX_TOKENS_OVERRIDE)
        print('openrouter free remaining =', quota_remaining())
        return

    if '--report' in sys.argv:
        report(load_state())
        return

    if '--rejects' in sys.argv:
        st = load_state()
        n = 0
        for u in st['units']:
            for r in u.get('rejectedRuns', []):
                n += 1
                print(f"{u['taskId']} {u['presetId']} rep{u['rep']} run={r['runId']} at={r['at']}")
                for p in r['problems']:
                    print('    -', p)
        print(f'total rejected runs kept for audit: {n}')
        return

    if '--reset-failed' in sys.argv:
        st = load_state()
        n = 0
        for u in st['units']:
            if u['status'] == 'failed':
                u['status'] = 'pending'
                u['runId'] = None
                u['attempts'] = 0
                n += 1
        save_state(st)
        print(f'reset {n} failed units to pending')
        return

    st = load_state()
    total = len(st['units'])
    # Units scored by an earlier driver build were never validated. Re-open them
    # so the validator runs; otherwise they would sail through as "scored".
    reopened = 0
    for u in st['units']:
        if u.get('status') == 'scored' and not u.get('valid'):
            u['status'] = 'unvalidated'
            reopened += 1
    if reopened:
        save_state(st)
    log(f'=== batch-270 start === variant={VARIANT} plan={total} depth={DEPTH} margin={QUOTA_MARGIN} '
        f'gen={gen_model} judge={judge_model} reopened={reopened}')
    last_quota = 0.0
    remaining = None
    rejected = 0

    while True:
        try:
            runs = {r['runId']: r for r in http_get('/api/playground/runs?limit=1000')}
        except Exception as e:
            log(f'server poll failed: {type(e).__name__} {e}; retry in 20s')
            time.sleep(20)
            continue

        inflight = 0
        quota_hit = False
        to_check = []
        for u in st['units']:
            rid = u.get('runId')
            if not rid:
                continue
            r = runs.get(rid)
            if not r:
                # Run vanished (deleted elsewhere, or aged out of the window).
                u['runId'] = None
                if u['status'] not in ('failed',):
                    u['status'] = 'pending'
                continue
            s = r.get('status')
            if s in ('queued', 'running'):
                inflight += 1
            elif s == 'scored' and u['status'] != 'scored':
                to_check.append(u)
            elif s == 'error' and u['status'] != 'failed':
                err = str(r.get('error') or '')
                if RATE_LIMIT_RE.search(err):
                    # Free-tier quota exhausted: park the unit as pending WITHOUT
                    # burning an attempt, and raise the pause flag so the batch
                    # stops and waits for the daily reset.
                    quota_hit = True
                    u['status'] = 'pending'
                    u['runId'] = None
                    u.setdefault('rejects', []).append(f'quota-limited (no attempt burned): {err[:100]}')
                else:
                    u['attempts'] += 1
                    u.setdefault('rejects', []).append(f"run-error: {err[:120]}")
                    if u['attempts'] < MAX_ATTEMPTS:
                        u['status'] = 'pending'
                    else:
                        u['status'] = 'failed'
                    u['runId'] = None
                    rejected += 1

        # Validate every newly scored run; delete + re-run the invalid ones.
        for u in to_check:
            try:
                d = http_get('/api/playground/runs/' + u['runId'])
            except Exception as e:
                log(f'detail fetch failed {u["runId"]}: {e}')
                continue
            problems = validate(d, gen_model, judge_model)
            if not problems:
                u['status'] = 'scored'
                u['valid'] = True
                u['acceptedRunId'] = u['runId']
            else:
                rejected += 1
                u['attempts'] += 1
                u.setdefault('rejects', []).append('; '.join(problems))
                # Keep the run for audit instead of deleting it: the failure is
                # the evidence, and the grid shows the newest run per cell, so a
                # later accepted re-run supersedes it on screen.
                u.setdefault('rejectedRuns', []).append({
                    'runId': u['runId'],
                    'at': datetime.now(timezone.utc).isoformat(),
                    'problems': problems,
                })
                log(f'REJECT {u["taskId"]} {u["presetId"]} rep{u["rep"]} attempt{u["attempts"]} '
                    f'run={u["runId"]} kept-for-audit: {"; ".join(problems)}')
                u['runId'] = None
                u['status'] = 'pending' if u['attempts'] < MAX_ATTEMPTS else 'failed'

        save_state(st)

        pending = [u for u in st['units'] if u['status'] == 'pending']
        c = counts(st)
        done = c.get('scored', 0) + c.get('failed', 0)
        log(f'progress done={done}/{total} scored={c.get("scored", 0)} failed={c.get("failed", 0)} '
            f'inflight={inflight} pending={len(pending)} rejected={rejected} remaining={remaining}')

        if not pending and inflight == 0:
            log(f'=== ALL DONE === scored={c.get("scored", 0)} failed={c.get("failed", 0)} rejected={rejected}')
            break

        now = time.time()
        if now - last_quota > QUOTA_POLL_SEC:
            last_quota = now
            q = quota_remaining()
            if q is not None:
                remaining = q

        if quota_hit or (remaining is not None and remaining < QUOTA_MARGIN):
            log(f'RATE LIMITED / quota exhausted (quota_hit={quota_hit} remaining={remaining}): '
                f'pausing, wait for daily reset')
            st['paused'] = True
            st['pausedAt'] = datetime.now(timezone.utc).isoformat()
            save_state(st)
            while True:
                time.sleep(600)
                q = quota_remaining()
                log(f'quota recheck remaining={q}')
                if q is not None and q > RESUME_ABOVE:
                    remaining = q
                    st['paused'] = False
                    save_state(st)
                    log('quota reset detected; resuming')
                    break
            continue

        if inflight < DEPTH and pending:
            chunk = pending[:DEPTH - inflight]
            groups = {}
            for u in chunk:
                groups.setdefault((u['presetId'], max_tokens_for(u['taskId'])), []).append(u)
            for (preset, mt), group in groups.items():
                body = {'taskIds': [u['taskId'] for u in group], 'presetId': preset}
                if mt:
                    body['maxTokens'] = mt
                try:
                    resp = http_post('/api/playground/runs', body)
                except Exception as e:
                    log(f'enqueue failed preset={preset}: {type(e).__name__} {e}')
                    continue
                if resp.get('error'):
                    log(f'enqueue rejected preset={preset}: {resp["error"]}')
                    continue
                created = resp.get('created') or []
                for i, u in enumerate(group):
                    if i < len(created):
                        u['runId'] = created[i]['runId']
                        u['status'] = 'queued'
                log(f'enqueued {len(created)} preset={preset} maxTokens={mt} '
                    f'taskIds={[u["taskId"] for u in group]}')
            save_state(st)

        time.sleep(POLL_SEC)


if __name__ == '__main__':
    main()
