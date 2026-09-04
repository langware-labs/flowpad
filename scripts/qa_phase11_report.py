#!/usr/bin/env python3
"""Aggregate the Phase 11 sweep: per-file exit code + console-error count."""
import json, sys, os, glob, collections

out = sys.argv[1]
rows = []
for jf in sorted(glob.glob(os.path.join(out, "phase11--*.json"))):
    name = os.path.basename(jf)[len("phase11--"):-len(".json")]
    cat, _, base = name.partition("--")
    try:
        d = json.load(open(jf))
    except Exception as e:
        rows.append((cat, base, "PARSE_ERR", 0, 0, [str(e)])); continue
    stats = collections.Counter(); errs = []
    def walk(s):
        for sp in s.get("suites", []): walk(sp)
        for sp in s.get("specs", []):
            for t in sp.get("tests", []):
                for r in t.get("results", []):
                    stats[r["status"]] += 1
                    if r["status"] not in ("passed", "skipped"):
                        m = (r.get("error") or {}).get("message", "")
                        errs.append(f"{sp['title']} :: {m.splitlines()[0][:160] if m else r['status']}")
    for s in d.get("suites", []): walk(s)
    sink = os.path.join(out, "console", f"{cat}--{base}.jsonl")
    clines = []
    if os.path.exists(sink):
        clines = [l for l in open(sink).read().splitlines() if l.strip()]
    rows.append((cat, base, stats, len(clines), errs))

nred = 0; nconsole = 0
print(f"{'file':<70} {'pass':>4} {'fail':>4} {'skip':>4} {'console':>7}")
print("-"*95)
for cat, base, stats, nc, errs in rows:
    if stats == "PARSE_ERR":
        print(f"{cat+'/'+base:<70} {'PARSE ERROR':>21}"); nred += 1; continue
    p = stats.get("passed",0); f = sum(v for k,v in stats.items() if k not in ("passed","skipped")); s = stats.get("skipped",0)
    flag = ""
    if f: flag += " FAIL"; nred += 1
    if nc: flag += " CONSOLE"; nconsole += 1
    print(f"{cat+'/'+base:<70} {p:>4} {f:>4} {s:>4} {nc:>7}{flag}")
print("-"*95)
print(f"files: {len(rows)}  red(test): {nred}  red(console): {nconsole}")
