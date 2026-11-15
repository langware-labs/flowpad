"""Lay one real run of a skill on its flowmap: the frames it went through, with the time and cost of each.

Usage:
  "$FLOWPAD_PYTHON" -I trace.py <session id> <skill dir> [--worker claude] [--from N] [--out <file>]

Reads the session's transcript (flow_sdk.transcript_analyzer — the same parser agent-trace uses), finds where the
skill was started, and walks what happened until the person spoke again with something that is not one of the
map's entries (a prompt that matches an entry's `say`, like a feedback relay, keeps the run going). Each tool call
lands in the step whose `match` substrings it contains; a call that matches nothing stays in the step before it.
A frame is the time the run sat in one node: its seconds run to the next frame, its cost is the usage priced in
that window plus the whole cost of any helper (sub-agent) spawned in it. No model is called for any number.
`--from N` picks the N-th start of the skill in the session (default: the last). Writes a `flowmap.run` value
(the map copied in), default `~/.flow/flowmap/runs/<skill>/<session>.value.json`, and prints a summary.
"""

import argparse
import json
import pathlib
import re
import sys
from bisect import bisect_left
from datetime import datetime

from flow_sdk.transcript_analyzer.assembly import assemble_tree
from flow_sdk.transcript_analyzer.entries.agent_spawn import AgentSpawnEntry
from flow_sdk.transcript_analyzer.entries.skill_call import SkillCallEntry
from flow_sdk.transcript_analyzer.entries.usage import UsageEntry
from flow_sdk.transcript_analyzer.entries.user_message import UserMessageEntry
from flow_sdk.transcript_analyzer.resolver import resolve_session_jsonl
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))   # -I leaves the script's folder off the path
from map_check import MAP  # noqa: E402

INJECTED = "Base directory for this skill:"
SYNTHETIC = ("<system-reminder>", "<command-", "<local-command", "<task-notification>", "[Request interrupted")


def _secs(a: str, b: str) -> float:
    def p(t: str) -> datetime:
        return datetime.fromisoformat(t.replace("Z", "+00:00"))
    return max(0.0, (p(b) - p(a)).total_seconds())


def _human(e) -> bool:
    text = (getattr(e, "text", "") or "").lstrip()
    return isinstance(e, UserMessageEntry) and not e.is_sidechain and bool(text) and not text.startswith(SYNTHETIC) \
        and not text.startswith(INJECTED)


def _starts(entries: list, skill: str) -> list[int]:
    """Where the skill was started: its Skill call, or the injected body when there was no call."""
    out = []
    for i, e in enumerate(entries):
        if isinstance(e, SkillCallEntry) and pathlib.Path(e.skill_name).name == skill.split(":")[-1]:
            out.append(i)
        elif isinstance(e, UserMessageEntry) and (e.text or "").lstrip().startswith(INJECTED) \
                and (e.text or "").splitlines()[0].rstrip("/").endswith("/" + skill) and not (out and i - out[-1] < 4):
            out.append(i)
    return out


def _entry_for(text: str, entries: list[dict]) -> str | None:
    t = (text or "").lower()
    for en in entries:
        if any(s.lower() in t for s in en.get("say") or [] if s):
            return en["id"]
    return None


READERS = {"cat", "sed", "head", "tail", "grep", "rg", "ls", "wc", "find", "echo", "diff", "less", "awk", "cut", "sort", "tree"}
READ_TOOLS = {"Read", "Grep", "Glob", "LS"}


def _acting(command: str) -> str:
    """A shell command without its read-only parts: reading a script is not running it."""
    parts = re.split(r"\s*(?:&&|\|\||;|\||\n)\s*", command or "")
    return " ; ".join(p for p in parts if p.split()[:1] and pathlib.Path(p.split()[0]).name not in READERS
                      and not p.split()[0].endswith("=") )


def _call_text(e) -> tuple[str, bool]:
    """The tool's name and what it did, and whether it only read — semantic entries (a shell command, a file
    write) carry their arguments as fields, not as `tool_input`. Only an instructions or screen step matches a read."""
    name = getattr(e, "tool_name", "") or ""
    command = getattr(e, "command", None)
    fields = [getattr(e, a, None) for a in ("path", "file_path", "pattern", "url", "skill_name", "description")]
    acting = _acting(command) if command else ""
    text = " ".join([f'"{name}"', json.dumps(getattr(e, "tool_input", None) or {}, ensure_ascii=False), acting,
                     *(str(f) for f in fields if f)])
    return text, name in READ_TOOLS or (command is not None and not acting)


def trace(session: str, skill_dir: pathlib.Path, worker: str = "claude", start_n: int | None = None) -> dict:
    m = json.loads((skill_dir / MAP).read_text(encoding="utf-8"))
    skill = m.get("skill") or skill_dir.name
    path = resolve_session_jsonl(worker, session)
    tr = AgentTranscriptFile(worker, path, session_id=session)
    assemble_tree(tr, session_id=session)
    entries = [e for e in tr.entries if not e.is_sidechain and e.timestamp]
    starts = _starts(entries, skill_dir.name)
    if not starts:
        sys.exit(f"{skill} was never started in session {session}")
    i0 = starts[(start_n - 1) if start_n else -1]
    said = next((e.text for e in reversed(entries[:i0]) if _human(e)), "") or ""
    first_entry = _entry_for(said, m["entries"]) or m["entries"][0]["id"]
    next_of: dict[str, list[str]] = {}
    for ln in m["links"]:
        next_of.setdefault(ln["from"], []).append(ln["to"])
    steps = m["steps"]
    frames: list[dict] = []

    def enter(entry: str, ts: str) -> None:
        """An entry, then the step it leads to."""
        frames.append({"node": entry, "start": ts})
        if next_of.get(entry):
            frames.append({"node": next_of[entry][0], "start": ts})

    enter(first_entry, entries[i0].timestamp)
    end = entries[-1].timestamp
    for e in entries[i0 + 1:]:
        if _human(e):
            again = _entry_for(e.text, m["entries"])
            if not again:
                end = e.timestamp
                break
            frames[-1].setdefault("note", "waiting for you")
            enter(again, e.timestamp)
            continue
        if not getattr(e, "tool_name", None):
            continue
        text, only_read = _call_text(e)
        # One command can do several steps (`build && validate`): each matched step, in the order it appears.
        hits = []
        for s in steps:
            if s["type"] == "code" and only_read:
                continue
            pos = [text.find(k) for k in s.get("match") or [] if k and k in text]
            if pos:
                hits.append((min(pos), s["id"]))
        for _, step in sorted(hits):
            if step != frames[-1]["node"]:
                frames.append({"node": step, "start": e.timestamp})
        if isinstance(e, AgentSpawnEntry):
            frames[-1].setdefault("_spawns", []).append(e)
        if getattr(e, "is_error", False) or getattr(e, "error", None):
            frames[-1]["note"] = "failed"

    usage = sorted((u for u in tr.usage if u.timestamp), key=lambda u: u.timestamp)
    stamps = [u.timestamp for u in usage]
    for k, f in enumerate(frames):
        stop = frames[k + 1]["start"] if k + 1 < len(frames) else end
        f["seconds"] = round(_secs(f["start"], stop), 1)
        own = usage[bisect_left(stamps, f["start"]):bisect_left(stamps, stop)]   # [start, stop): no double count
        helpers = [c for s in f.pop("_spawns", []) for c in s.walk() if c is not s and isinstance(c, UsageEntry)]
        f["cost"] = round(tr.cost_of(own + helpers), 4)
    # The last step goes on to an outcome when exactly one link leads there.
    outs = {o["id"] for o in m["outcomes"]}
    to_out = [t for t in next_of.get(frames[-1]["node"], []) if t in outs]
    if len(to_out) == 1:
        frames.append({"node": to_out[0], "start": end, "seconds": 0.0, "cost": 0.0})
    frames = [f for k, f in enumerate(frames) if not (f["seconds"] == 0 and k + 1 < len(frames)
                                                       and frames[k + 1]["node"] == f["node"])]
    return {
        "spec_kind": "flowmap.run", "skill": skill, "session": session, "when": frames[0]["start"], "said": said[:300],
        "seconds": round(sum(f["seconds"] for f in frames), 1), "cost": round(sum(f["cost"] for f in frames), 4),
        "map": {k: v for k, v in m.items() if k != "spec_kind"}, "frames": frames,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("session")
    ap.add_argument("skill_dir")
    ap.add_argument("--worker", default="claude")
    ap.add_argument("--from", dest="start_n", type=int)
    ap.add_argument("--out")
    a = ap.parse_args()
    skill_dir = pathlib.Path(a.skill_dir).expanduser().resolve()
    run = trace(a.session, skill_dir, a.worker, a.start_n)
    out = pathlib.Path(a.out) if a.out else pathlib.Path.home() / ".flow" / "flowmap" / "runs" / run["skill"] / f"{a.session}.value.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(run, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    off = sum(1 for x, y in zip(run["frames"], run["frames"][1:])
              if not any(ln["from"] == x["node"] and ln["to"] == y["node"] for ln in run["map"]["links"]))
    print(json.dumps({"ok": True, "run": str(out), "frames": len(run["frames"]), "seconds": run["seconds"], "cost": run["cost"],
                      "moves_off_the_map": off}))


if __name__ == "__main__":
    main()
