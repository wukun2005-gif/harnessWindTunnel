#!/usr/bin/env python3
"""
Gate-run watchdog: watches a §7.2④ hold-out gate re-run (or any long live run
batch) through the DATABASE, not through logs.

Why the DB and not a log file: the gate job is a detached task inside an
already-running server process. Teeing that process's stdout would mean
restarting it — which kills the very job we want to protect. Every unit of
progress the job makes lands in `pg_runs` the moment the run is created, so
`pg_runs` is the liveness signal that costs nothing to watch.

What it stops on (mirrors scripts/run-watchdog.py, but DB-driven):
  * STALL      — no new run row for --stall-sec seconds. An endpoint that stops
                 answering is the case that matters: it produces no error line
                 at all, so a purely content-matching watchdog sits there blind.
  * ERROR BURST— >= --error-burst runs finishing with a non-null error inside
                 --error-window seconds (a provider-wide 401/429/5xx).
  * HEALTH     — --health-url answers something other than HTTP 200 twice in a row.
  * CEILING    — the job has been running longer than --max-min minutes.
  * QUOTA      — the provider key's remaining daily request budget dropped below
                 --quota-floor. Checked every --quota-sec seconds; the point is
                 to warn BEFORE the job starts failing, not after.

It also prints a heartbeat with "seconds since last progress" so a human
watching the terminal can see liveness without hunting for timestamps.

Clean exits: the job's gate_status leaves 'running' (passed / failed / idle).

Usage:
  python3 scripts/gate-watchdog.py \
      --db server-data/playground.db --since 2026-10-13T08:04 \
      --port 4001 --stall-sec 300 --heartbeat-sec 60 [--stop]

  --stop  kills the server PID listening on --port when an alarm fires, so a
          wedged job stops burning tokens. Without it the watchdog only reports.
          It never touches a port you did not pass.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import re
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request


def now_iso() -> str:
    return dt.datetime.now().strftime('%Y-%m-%dT%H:%M:%S')


def log(msg: str) -> None:
    print(f'[watchdog {dt.datetime.now().strftime("%H:%M:%S")}] {msg}', flush=True)


def derive_since(db: str) -> str | None:
    """
    Start boundary taken from the job's OWN record, not typed by hand.

    A hand-typed --since is exactly how a watchdog ends up off by one: the gate
    job stamps its run ids into pg_evo_mutations.gate_json as it goes, so the
    earliest recorded run's created_at IS the job's start. Hand-typing that
    boundary once produced "89 runs" for a 90-run job and briefly looked like a
    lost run.
    """
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
    try:
        row = con.execute('SELECT gate_json FROM pg_evo_mutations LIMIT 1').fetchone()
        if not row or not row[0]:
            return None
        g = json.loads(row[0])
        ids = (g.get('baselineRunIds') or []) + (g.get('newRunIds') or [])
        if not ids:
            return None
        q = ','.join('?' * len(ids))
        return con.execute(
            f'SELECT min(created_at) FROM pg_runs WHERE run_id IN ({q})', ids).fetchone()[0]
    except Exception:
        return None
    finally:
        con.close()


def run_stats(db: str, since: str) -> dict:
    """Progress + error picture for runs created at/after `since`."""
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
    try:
        cur = con.cursor()
        cur.execute(
            'SELECT count(*), sum(status = \'scored\'), sum(error IS NOT NULL), '
            'max(created_at) FROM pg_runs WHERE created_at >= ?',
            (since,),
        )
        total, scored, errored, latest = cur.fetchone()
        cur.execute(
            'SELECT count(*) FROM pg_runs WHERE created_at >= ? AND error IS NOT NULL '
            'AND created_at >= ?',
            (since, since),
        )
        cur.execute('SELECT gate_status FROM pg_evo_mutations LIMIT 1')
        row = cur.fetchone()
        gate_status = row[0] if row else None
        return {
            'total': total or 0,
            'scored': scored or 0,
            'errored': errored or 0,
            'latest': latest,
            'gateStatus': gate_status,
        }
    finally:
        con.close()


def recent_error_burst(db: str, since: str, window_sec: int) -> int:
    """How many errored runs landed in the last `window_sec` seconds."""
    cutoff = (dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
              - dt.timedelta(seconds=window_sec)).strftime('%Y-%m-%dT%H:%M:%S')
    con = sqlite3.connect(f'file:{db}?mode=ro', uri=True, timeout=5)
    try:
        cur = con.cursor()
        cur.execute(
            'SELECT count(*) FROM pg_runs WHERE created_at >= ? AND created_at >= ? AND error IS NOT NULL',
            (since, cutoff),
        )
        return cur.fetchone()[0] or 0
    finally:
        con.close()


def openrouter_quota(settings_path: str) -> dict | None:
    """
    Ask OpenRouter what THIS key has left, rather than guessing from run counts.

    The distinction that matters: `free_model_daily_requests` is the account's own
    daily cap (1000/day once you hold credits). A 429 with
    `limit_source: upstream_provider_shared_pool` is a different animal — the free
    model's shared upstream pool being busy. Only the former can be planned around.
    """
    try:
        cfg = json.loads(pathlib.Path(settings_path).read_text(encoding='utf-8'))
        key = cfg.get('provider_openrouter', {}).get('apiKeyRef')
        if not key:
            return None
        req = urllib.request.Request(
            'https://openrouter.ai/api/v1/key',
            headers={'Authorization': f'Bearer {key}', 'Accept': 'application/json'},
        )
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode()).get('data', {})
        q = data.get('free_model_daily_requests') or {}
        return {
            'used': q.get('used'),
            'limit': q.get('limit'),
            'remaining': q.get('remaining'),
            'freeTier': data.get('is_free_tier'),
        }
    except Exception as e:
        log(f'quota check failed (not fatal): {type(e).__name__}: {e}')
        return None


def health_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=10) as resp:
            return 200 <= resp.status < 300
    except urllib.error.HTTPError as e:
        return 200 <= e.code < 300
    except Exception:
        return False


def pid_on_port(port: int) -> int | None:
    """PID listening on `port`, or None. Only ever called with the user's port."""
    try:
        out = subprocess.run(
            ['lsof', '-nP', f'-iTCP:{port}', '-sTCP:LISTEN', '-t'],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip()
    except Exception:
        return None
    if not out:
        return None
    m = re.search(r'\d+', out)
    return int(m.group(0)) if m else None


def stop_server(port: int) -> None:
    pid = pid_on_port(port)
    if pid is None:
        log(f'--stop: nothing listening on {port}; nothing to kill.')
        return
    log(f'--stop: sending SIGTERM to pid {pid} on port {port}.')
    try:
        os.kill(pid, signal.SIGTERM)
    except Exception as e:
        log(f'--stop: kill failed: {e}')
        return
    time.sleep(3)
    if pid_on_port(port) is None:
        log('--stop: server is down. The gate job died with it; the row still says '
            '"running" until the next server start, where staleGuard() reports it as '
            'interrupted by a process restart.')
    else:
        log('--stop: server still listening after SIGTERM.')


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', default='server-data/playground.db')
    ap.add_argument('--since', default=None,
                    help='ISO timestamp; runs at/after this count as this job. '
                         'Omitted → derived from the mutation\'s recorded gate run ids.')
    ap.add_argument('--stall-sec', type=int, default=300)
    ap.add_argument('--heartbeat-sec', type=int, default=60)
    ap.add_argument('--error-burst', type=int, default=3)
    ap.add_argument('--error-window', type=int, default=300)
    ap.add_argument('--max-min', type=int, default=180)
    ap.add_argument('--health-url', default=None)
    ap.add_argument('--port', type=int, default=None, help='server port, only used by --stop')
    ap.add_argument('--stop', action='store_true', help='kill the server on an alarm')
    ap.add_argument('--settings', default='server-data/settings.json',
                    help='server settings file holding the provider key (never printed)')
    ap.add_argument('--quota-floor', type=int, default=None,
                    help='alarm when the free-model daily request budget drops below this')
    ap.add_argument('--quota-sec', type=int, default=300)
    ap.add_argument('--once', action='store_true', help='print one snapshot and exit (smoke test)')
    args = ap.parse_args()

    if args.stop and not args.port:
        log('--stop requires --port. Refusing to guess which server to kill.')
        return 2

    if not args.since:
        args.since = derive_since(args.db)
        if not args.since:
            log('No --since given and the job has no recorded runs yet. Pass --since explicitly.')
            return 2
        log(f'boundary derived from the job record: since={args.since}')

    started = time.time()
    last_progress_at = time.time()
    last_total = -1
    health_fails = 0
    last_beat = 0.0
    last_quota_at = 0.0
    quota = None

    while True:
        st = run_stats(args.db, args.since)
        now = time.time()

        if st['total'] != last_total:
            if st['total'] > last_total >= 0:
                log(f"progress: {st['total']} run(s) created, {st['scored']} scored, "
                    f"{st['errored']} errored (latest {st['latest']})")
            last_total = st['total']
            last_progress_at = now

        if args.once:
            log(f"snapshot: gateStatus={st['gateStatus']} total={st['total']} "
                f"scored={st['scored']} errored={st['errored']}")
            return 0

        # Clean finish: the job wrote a terminal gate status.
        if st['gateStatus'] not in (None, 'running'):
            log(f"FINISHED: gateStatus={st['gateStatus']} after {st['total']} run(s) "
                f"({st['scored']} scored, {st['errored']} errored).")
            return 0

        alarm = None
        if now - last_progress_at > args.stall_sec:
            alarm = (f"STALL: no new run for {int(now - last_progress_at)}s "
                     f"(limit {args.stall_sec}s). An endpoint that stopped answering "
                     f"looks exactly like this.")
        burst = recent_error_burst(args.db, args.since, args.error_window)
        if alarm is None and burst >= args.error_burst:
            alarm = (f"ERROR BURST: {burst} errored run(s) in the last "
                     f"{args.error_window}s (limit {args.error_burst}).")
        if alarm is None and args.health_url:
            if health_ok(args.health_url):
                health_fails = 0
            else:
                health_fails += 1
                if health_fails >= 2:
                    alarm = f"HEALTH: {args.health_url} failed {health_fails} times in a row."
        if args.quota_floor is not None and now - last_quota_at >= args.quota_sec:
            last_quota_at = now
            quota = openrouter_quota(args.settings)
            if quota and quota.get('remaining') is not None:
                log(f"quota: free-model daily requests {quota['used']}/{quota['limit']} "
                    f"(remaining {quota['remaining']}, freeTier={quota['freeTier']})")
                if alarm is None and quota['remaining'] <= args.quota_floor:
                    alarm = (f"QUOTA: only {quota['remaining']} free-model request(s) left "
                             f"today (floor {args.quota_floor}). The job needs roughly "
                             f"2 per remaining run. Do NOT switch models on your own — "
                             f"report and wait for a human decision.")

        if alarm is None and (now - started) > args.max_min * 60:
            alarm = f"CEILING: running longer than {args.max_min} min."

        if alarm:
            log(f'ALARM — {alarm}')
            if args.stop:
                stop_server(args.port)
            else:
                log('--stop not set: reporting only, the job is still burning tokens.')
            return 1

        if now - last_beat >= args.heartbeat_sec:
            last_beat = now
            q = f", quotaLeft={quota['remaining']}" if quota and quota.get('remaining') is not None else ''
            log(f"heartbeat: {st['total']} run(s), {st['scored']} scored, "
                f"{st['errored']} errored, gateStatus={st['gateStatus']}, "
                f"{int(now - last_progress_at)}s since last progress{q}")

        time.sleep(10)


if __name__ == '__main__':
    sys.exit(main())
