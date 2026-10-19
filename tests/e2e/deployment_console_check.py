"""Check a channels-mix run's browser capture: every answer appeared in the deployment's process
console as it was sent — its "→ <channel>" line on the page within 5 s of the runner seeing the answer
(earlier is fine: the runner reads a pulled channel's double late).

    uv run python tests/e2e/deployment_console_check.py <run dir>   # --report run.json, --watch-out <run dir>/browser

Reads <run>/run.log, report.json and browser/timeline.jsonl; prints one row per step, then OK / FAIL."""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

run = Path(sys.argv[1])
report = json.loads((run / "report.json").read_text())
channels = [json.loads(l)["channels"] for l in (run / "run.log").read_text().splitlines() if '"step": "channels"' in l][0]
label_of = {}  # provider -> the channel label the console prints
for t in report["threads"]:
    for provider, sid in channels.items():
        if t["data_source_id"] == sid:
            label_of[provider] = t["channel"]

# Every console line, with when the browser first showed it (a snapshot a second). Rows are wrapped:
# join a snapshot's rows and split on the loop's own "HH:MM:SS " stamps.
first_seen: dict[str, datetime] = {}
for line in (run / "browser" / "timeline.jsonl").read_text().splitlines():
    snap = json.loads(line)
    at = datetime.fromisoformat(snap["t"].replace("Z", "+00:00"))
    flat = "".join(snap.get("console") or [])
    for entry in re.split(r"(?=\d\d:\d\d:\d\d [←→▶·✗d])", flat):
        entry = entry.strip()
        if re.match(r"\d\d:\d\d:\d\d ", entry):
            first_seen.setdefault(entry, at)

steps = [json.loads(l) for l in (run / "run.log").read_text().splitlines() if '"channel"' in l and '"answer"' in l]
day = datetime.now().date()
ok = True
rows = []
for step in steps:
    provider, answer = step["channel"], step["answer"]
    label = label_of.get(provider, provider)
    seen_at = datetime.combine(day, datetime.strptime(step["t"], "%H:%M:%S").time()).astimezone(timezone.utc)

    def stamp(e):  # the loop's own HH:MM:SS, as a local time today
        return datetime.combine(day, datetime.strptime(e[:8], "%H:%M:%S").time()).astimezone(timezone.utc).timestamp()

    replies = [(e, at) for e, at in first_seen.items()
               if f"→ {label}" in e and e.rstrip().endswith(answer[:40].strip()) and stamp(e) <= seen_at.timestamp() + 1]
    ins = [e for e in first_seen if f"← {label}" in e]
    if not replies:
        ok = False
        rows.append((provider, step["step"], "NO REPLY LINE IN THE CONSOLE", ""))
        continue
    entry, shown = max(replies, key=lambda r: stamp(r[0]))  # this step's: the latest one sent by then
    lag = (shown - seen_at).total_seconds()
    rows.append((provider, step["step"], f"reply line shown {lag:+.1f}s vs the runner seeing the answer", f"{len(ins)} message-in lines"))
    if lag > 5:
        ok = False
for r in rows:
    print(" | ".join(str(x) for x in r))
print("console lines captured:", len(first_seen), "| channels:", label_of)
print("OK" if ok else "FAIL")
