#!/usr/bin/env python3
"""
Run watchdog: watch the logs of a long-running job and STOP it the moment
something looks wrong.

Anomalies that stop the run:
  * server health check fails twice in a row
  * an auth/rate-limit/upstream error from any provider: HTTP 401/403/429/5xx
  * the server crashed (EADDRINUSE / unhandled throw)
  * the batch log shows >= BURST rejects inside BURST_WINDOW seconds
  * the batch driver process disappears while units are still pending
  * STALL — no new output in ANY watched log for --stall-sec seconds.
    This is the one that matters most in practice: an endpoint that stops
    answering produces no error line at all, so a purely content-matching
    watchdog sits there blind while the job is already dead. Silence longer
    than the job's normal cadence IS the alarm.

It also prints a heartbeat with "seconds since last output" so a human looking
at the terminal can see liveness without hunting for timestamps.

Usage:
  python3 scripts/run-watchdog.py \
      --batch-log server-data/batch270/run-c2web.log \
      --dev-log  server-data/dev.log \
      --stall-sec 300 --heartbeat-sec 120 [--stop]

  --dev-log / --batch-log / --extra-log may each be repeated to watch several
  files at once. Every watched file contributes to the stall clock: as long as
  ANY file is still producing lines, the job is considered alive.
"""
import argparse
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FATAL_PATTERNS = [
    (re.compile(r'HTTP (401|403|429|5\d\d)'), 'provider HTTP error'),
    (re.compile(r'\bEADDRINUSE\b'), 'server port clash / crash'),
    (re.compile(r'Unhandled .event|throw er;'), 'server unhandled crash'),
    (re.compile(r'rate_limit_exceeded|rate limited', re.I), 'rate limited'),
    (re.compile(r'Jev 调用失败|判定卡.*失败'), 'Jev call failed'),
]
NOISY_PATTERNS = [
    (re.compile(r'\bWARN\b'), 'warning'),
    (re.compile(r'response_format skipped'), 'response_format skipped'),
    (re.compile(r'超时|timeout', re.I), 'timeout'),
]

BURST = 5
BURST_WINDOW = 120.0
HEALTH = 'http://localhost:4000/api/health'


class Watched:
    """One tailed file: offset + when we last saw something new in it."""

    def __init__(self, path):
        self.path = path
        self.offset = None
        self.last_line = None

    def poll(self):
        """Return the new lines appended since the last poll (may be empty)."""
        if not os.path.exists(self.path):
            return []
        try:
            size = os.path.getsize(self.path)
        except OSError:
            return []
        if self.offset is None:
            # Start at the end: we care about what happens from now on.
            self.offset = size
            return []
        if size < self.offset:          # rotated / truncated
            self.offset = 0
        if size == self.offset:
            return []
        try:
            with open(self.path, encoding='utf-8', errors='replace') as f:
                f.seek(self.offset)
                chunk = f.read()
        except OSError:
            return []
        self.offset = size
        return [l for l in chunk.splitlines() if l.strip()]


def health_ok():
    try:
        with urllib.request.urlopen(HEALTH, timeout=5) as r:
            return r.status == 200
    except Exception:
        return False


def proc_alive(pattern):
    try:
        out = subprocess.run(['pgrep', '-f', pattern], capture_output=True, text=True)
        return bool(out.stdout.strip())
    except Exception:
        return True                     # pgrep unavailable: don't cry wolf


def pending_left(batch_log):
    """Last 'pending=N' seen in the batch log, or None if unknown."""
    try:
        with open(batch_log, encoding='utf-8', errors='replace') as f:
            for line in reversed(f.readlines()[-200:]):
                m = re.search(r'pending=(\d+)', line)
                if m:
                    return int(m.group(1))
    except Exception:
        pass
    return None


def fmt(seconds):
    seconds = int(seconds)
    return f'{seconds // 60}m{seconds % 60:02d}s' if seconds >= 60 else f'{seconds}s'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--batch-log', action='append', default=[],
                    help='may be repeated')
    ap.add_argument('--dev-log', action='append', default=[],
                    help='may be repeated')
    ap.add_argument('--extra-log', action='append', default=[],
                    help='any other log to fold into the stall clock (repeatable)')
    ap.add_argument('--stall-sec', type=float, default=300.0,
                    help='alarm when NOTHING is written to any watched log for this long (default 300)')
    ap.add_argument('--heartbeat-sec', type=float, default=120.0,
                    help='print a liveness line this often (0 disables)')
    ap.add_argument('--require-proc', default=None,
                    help='if given, alarm when this pgrep -f pattern disappears')
    ap.add_argument('--no-health', action='store_true',
                    help='skip the :4000 health check — use when the job does NOT need the HTTP server '
                         '(e.g. a script that talks to the sqlite file directly)')
    ap.add_argument('--done-pattern', default=r'ALL DONE|^written: ',
                    help='regex; a new line matching it means the job FINISHED normally, so exit 0 '
                         'instead of later crying stall at the silence that follows (default covers '
                         'batch-270 "ALL DONE" and eval-judges "written: ...")')
    ap.add_argument('--stop', action='store_true',
                    help='actually kill the batch on anomaly')
    args = ap.parse_args()

    paths = []
    for p in args.batch_log + args.dev_log + args.extra_log:
        p = p if os.path.isabs(p) else os.path.join(ROOT, p)
        if p not in paths:
            paths.append(p)
    if not paths:
        paths = [os.path.join(ROOT, 'server-data', 'dev.log')]

    batch_logs = [p if os.path.isabs(p) else os.path.join(ROOT, p) for p in args.batch_log]

    print(f'[watchdog] watching {len(paths)} log(s), stall={fmt(args.stall_sec)}, '
          f'heartbeat={fmt(args.heartbeat_sec) if args.heartbeat_sec else "off"}, stop={args.stop}',
          flush=True)
    for p in paths:
        print(f'[watchdog]   - {p}', flush=True)

    watched = [Watched(p) for p in paths]
    for w in watched:                     # prime the offsets to EOF
        w.poll()

    # Seed the stall clock from reality, not from "now": if the job already
    # went quiet before the watchdog was started, we must say so immediately
    # instead of granting it a fresh, silent stall window.
    mtimes = []
    for p in paths:
        try:
            mtimes.append(os.path.getmtime(p))
        except OSError:
            pass
    last_activity = max(mtimes) if mtimes else time.time()
    print(f'[watchdog] newest watched log is {fmt(time.time() - last_activity)} old', flush=True)

    health_fail = 0
    rejects = []
    noisy = {}
    last_health = time.time()
    last_beat = time.time()

    def anomaly(kind, detail):
        print(f'[watchdog] ANOMALY: {kind} :: {detail}', flush=True)
        if args.stop:
            subprocess.run(['pkill', '-f', 'batch-270'], capture_output=True)
            print('[watchdog] batch stopped', flush=True)
        sys.exit(2)

    while True:
        now = time.time()

        # 1) server health every 15s (skippable: a sqlite-only job needs no server)
        if not args.no_health and now - last_health > 15:
            last_health = now
            if health_ok():
                health_fail = 0
            else:
                health_fail += 1
                print(f'[watchdog] health check failed ({health_fail}/2)', flush=True)
                if health_fail >= 2:
                    anomaly('server-down', 'health check failed twice in a row')

        # 2) drain every watched file
        for w in watched:
            new_lines = w.poll()
            if not new_lines:
                continue
            last_activity = now
            w.last_line = new_lines[-1]

            # Completion beats everything: once the job says it is done, the silence
            # that follows is normal, not a stall. Without this the watchdog sits on a
            # finished job and eventually false-alarms.
            for line in new_lines:
                if args.done_pattern and re.search(args.done_pattern, line):
                    print(f'[watchdog] job finished normally ({os.path.basename(w.path)}): {line[:160]}',
                          flush=True)
                    sys.exit(0)

            for line in new_lines:
                for pat, label in FATAL_PATTERNS:
                    if pat.search(line):
                        anomaly(label, f'{os.path.basename(w.path)}: {line[:200]}')
                for pat, label in NOISY_PATTERNS:
                    if pat.search(line):
                        noisy[label] = noisy.get(label, 0) + 1

            # batch-specific bookkeeping
            if w.path in batch_logs:
                for line in new_lines:
                    if 'REJECT' in line:
                        rejects.append(now)
                        rejects = [t for t in rejects if now - t <= BURST_WINDOW]
                        if len(rejects) >= BURST:
                            anomaly('reject-burst',
                                    f'{len(rejects)} rejects within {BURST_WINDOW:.0f}s')
                    if 'ALL DONE' in line:
                        print(f'[watchdog] batch finished. noisy={noisy}', flush=True)
                        sys.exit(0)
                left = pending_left(w.path)
                if left is not None and left > 0 and not proc_alive('batch-270'):
                    anomaly('batch-died', 'batch process gone while units remain pending')

        # 3) the check the old version was missing entirely
        idle = time.time() - last_activity
        if idle > args.stall_sec:
            last = next((w for w in watched if w.last_line), None)
            last_path = last.path if last else 'n/a'
            last_text = (last.last_line or '')[-160:] if last else ''
            anomaly('stall',
                    f'no new output in ANY watched log for {fmt(idle)} '
                    f'(limit {fmt(args.stall_sec)}); '
                    f'last line seen: {last_path} :: {last_text}')

        # 4) optional liveness prober
        if args.require_proc and not proc_alive(args.require_proc):
            anomaly('proc-gone', f'process matching "{args.require_proc}" is gone')

        # 5) heartbeat so a human can see it is alive and how quiet things are
        if args.heartbeat_sec and time.time() - last_beat > args.heartbeat_sec:
            last_beat = time.time()
            print(f'[watchdog] alive — last output {fmt(idle)} ago, '
                  f'rejects={len(rejects)}, health_fail={health_fail}', flush=True)

        time.sleep(1.0)


if __name__ == '__main__':
    main()
