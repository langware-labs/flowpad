#!/usr/bin/env python3
"""Run a PowerShell script on the Windows VM and print its output.

  vmrun.py 'Get-ComputerInfo | select OsName'      # user lane (normal token)
  vmrun.py -a 'winget install ...'                  # admin lane (elevated)
  echo '...' | vmrun.py -t 1800 -                   # script from stdin, 30 min cap
  vmrun.py --status                                 # seconds since each lane last polled
Exit code = the script's exit code.
"""
import argparse, json, os, sys, urllib.request

Q = f"http://127.0.0.1:{os.environ.get('VMQ_PORT', 8766)}"
ap = argparse.ArgumentParser()
ap.add_argument("script", nargs="?")
ap.add_argument("-a", "--admin", action="store_true")
ap.add_argument("-t", "--timeout", type=int, default=600)
ap.add_argument("--status", action="store_true")
a = ap.parse_args()
if a.status:
    print(urllib.request.urlopen(f"{Q}/status").read().decode()); sys.exit(0)
script = sys.stdin.read() if a.script in (None, "-") else a.script
lane = "admin" if a.admin else "user"
req = urllib.request.Request(f"{Q}/submit?lane={lane}&timeout={a.timeout}", data=script.encode(), method="POST")
jid = json.load(urllib.request.urlopen(req))["id"]
while True:
    r = urllib.request.urlopen(f"{Q}/wait/{jid}?t=30", timeout=60)
    if r.status == 200:
        res = json.load(r)
        sys.stdout.write(res.get("out") or "")
        if res.get("timed_out"):
            print(f"\n[vmrun] TIMED OUT after {a.timeout}s", file=sys.stderr)
        sys.exit(res.get("code") if isinstance(res.get("code"), int) else 1)
