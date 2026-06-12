"""AgentTrace skeleton synthesizer — deterministic timeline from a transcript.

Builds the trace JSON (schema v1, below) the AgentTrace entity stores in its
``trace.json``: lanes (root + one per spawned subagent), segments (cut at user
prompts and long idle gaps), per-segment tool calls with cost/severity, and
deterministic markers (tool failures, stuck loops, skill loads/fails, user
interrupts). Everything timing/counting lives here; the ``agent-trace`` skill
adds the judgment layer on top via :func:`merge_annotations` — goals,
divergences, verdicts — without touching the skeleton.

Schema v1::

    {
      "version": 1, "id", "name", "session_id", "worker_type", "generated_at",
      "summary": {verdict, verdict_reason, duration_ms, cost_usd, issue_count,
                  divergence_count, lane_count, tool_call_count},
      "lanes": [{id, kind: root|subagent, agent_type, description,
                 parent_lane_id, spawn_tool_use_id, start_ts, end_ts,
                 segments: [{id, start_ts, end_ts, label, cost_usd, severity,
                             tool_calls: [{ts, kind, tool_name, skill_name,
                                           exit_code, duration_ms, severity,
                                           preview, entry_id}]}]}],
      "events":  [{ts, lane_id, kind: user_prompt|skill_load|skill_fail|
                   agent_spawn|interrupt, label, severity, entry_id}],
      "markers": [{ts, lane_id, kind: issue|divergence|stuck, severity,
                   label, detail, source: synthesizer|skill}],
      "annotations": {goals: [], divergences: [], verdict, notes: []}
    }

CLI (what the agent-trace skill runs)::

    uv run python -m flow_sdk.transcript_analyzer.synthesizers.agent_trace \
        <session_id> [--worker claude] [--out skeleton.json]
    uv run python -m flow_sdk.transcript_analyzer.synthesizers.agent_trace \
        --merge skeleton.json annotations.json [--out trace.json]
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from ..entries import (
    AgentSpawnEntry,
    ShellCommandEntry,
    SkillCallEntry,
    ToolResultEntry,
    ToolUseEntry,
    UserMessageEntry,
)
from ..entry import EntryKind, TranscriptEntry
from ..resolver import resolve_session_jsonl
from ..severity import SeverityTier
from ..transcript import AgentTranscriptFile

# A wall-clock gap inside a turn longer than this cuts a new segment. Gaps at
# a prompt boundary are the human away — never a stuck signal (see _segments).
IDLE_GAP_CUT_S = 120

# Same failing command this many times in a row → stuck marker.
STUCK_REPEAT_THRESHOLD = 3

_PREVIEW_CHARS = 200
_LABEL_CHARS = 120

# Tool-call kinds surfaced on segments (the "what was the agent doing" stream).
_CALL_KINDS = frozenset({
    EntryKind.TOOL_USE,
    EntryKind.SHELL_COMMAND,
    EntryKind.FILE_READ,
    EntryKind.FILE_WRITE,
    EntryKind.FILE_EDIT,
    EntryKind.SKILL_CALL,
    EntryKind.SEARCH,
    EntryKind.WEB_FETCH,
    EntryKind.TODO_UPDATE,
    EntryKind.AGENT_SPAWN,
})

_INTERRUPT_PREFIX = "[Request interrupted"


def _ts_ms(ts: str) -> int | None:
    if not ts:
        return None
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def _clip(text: str | None, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _entry_severity(e: TranscriptEntry, error_ids: set[str]) -> str:
    exit_code = getattr(e, "exit_code", None)
    if exit_code not in (None, 0):
        return SeverityTier.ATTENTION.value
    # Folded-in result error flag (Claude Bash results carry no exitCode).
    if getattr(e, "is_error", False):
        return SeverityTier.ATTENTION.value
    tuid = getattr(e, "tool_use_id", "")
    if tuid and tuid in error_ids:
        return SeverityTier.ATTENTION.value
    return SeverityTier.INFO.value


def _call_preview(e: TranscriptEntry) -> str:
    if isinstance(e, ShellCommandEntry):
        return _clip(e.command, _PREVIEW_CHARS)
    if isinstance(e, SkillCallEntry):
        return _clip(e.skill_name, _PREVIEW_CHARS)
    if isinstance(e, AgentSpawnEntry):
        return _clip(e.description or e.agent_type, _PREVIEW_CHARS)
    path = getattr(e, "path", None)
    if path:
        return _clip(str(path), _PREVIEW_CHARS)
    tool_input = getattr(e, "tool_input", None)
    if tool_input:
        return _clip(json.dumps(tool_input), _PREVIEW_CHARS)
    return ""


def _call_dict(e: TranscriptEntry, error_ids: set[str]) -> dict:
    return {
        "ts": e.timestamp,
        "kind": e.kind.value,
        "tool_name": getattr(e, "tool_name", "") or "",
        "skill_name": getattr(e, "skill_name", None),
        "exit_code": getattr(e, "exit_code", None),
        "duration_ms": getattr(e, "duration_ms", None),
        "severity": _entry_severity(e, error_ids),
        "preview": _call_preview(e),
        "entry_id": e.id,
    }


def _error_result_ids(entries: list[TranscriptEntry]) -> set[str]:
    """tool_use_ids whose (unfolded) result row reported is_error."""
    return {
        e.tool_use_id
        for e in entries
        if isinstance(e, ToolResultEntry) and e.is_error and e.tool_use_id
    }


def _is_prompt(e: TranscriptEntry) -> bool:
    if not isinstance(e, UserMessageEntry) or e.is_sidechain:
        return False
    text = (e.text or "").strip()
    return bool(text) and not text.startswith(_INTERRUPT_PREFIX)


def _segments(lane_id: str, entries: list[TranscriptEntry], transcript: AgentTranscriptFile) -> list[dict]:
    """Cut the entry stream into segments at prompts and intra-turn idle gaps."""
    segments: list[dict] = []
    current: list[TranscriptEntry] = []
    label = ""
    seq = 0

    def flush() -> None:
        nonlocal current, seq
        stamped = [e for e in current if e.timestamp]
        if not stamped:
            current = []
            return
        error_ids = _error_result_ids(current)
        calls = [_call_dict(e, error_ids) for e in current if e.kind in _CALL_KINDS]
        start_ts, end_ts = stamped[0].timestamp, stamped[-1].timestamp
        severity = SeverityTier.INFO.value
        if any(c["severity"] == SeverityTier.ATTENTION.value for c in calls):
            severity = SeverityTier.ATTENTION.value
        segments.append({
            "id": f"{lane_id}:{seq}",
            "start_ts": start_ts,
            "end_ts": end_ts,
            "label": label,
            "cost_usd": round(transcript.cost_in_span(start_ts, end_ts), 6),
            "severity": severity,
            "tool_calls": calls,
        })
        seq += 1
        current = []

    last_ms: int | None = None
    for e in entries:
        ms = _ts_ms(e.timestamp)
        if _is_prompt(e):
            flush()
            label = _clip(e.text, _LABEL_CHARS)
        elif current and ms is not None and last_ms is not None and ms - last_ms > IDLE_GAP_CUT_S * 1000:
            flush()
            label = "(idle gap)"
        if ms is not None:
            last_ms = ms
        current.append(e)
    flush()
    return segments


def _lane_markers(lane_id: str, entries: list[TranscriptEntry]) -> list[dict]:
    """Deterministic issue/stuck markers for one lane."""
    markers: list[dict] = []
    error_ids = _error_result_ids(entries)

    # Tool failures → issue markers.
    for e in entries:
        if e.kind not in _CALL_KINDS:
            continue
        if _entry_severity(e, error_ids) != SeverityTier.ATTENTION.value:
            continue
        markers.append({
            "ts": e.timestamp,
            "lane_id": lane_id,
            "kind": "issue",
            "severity": SeverityTier.ATTENTION.value,
            "label": f"{getattr(e, 'tool_name', '') or e.kind.value} failed",
            "detail": _call_preview(e),
            "source": "synthesizer",
        })

    # Stuck: same failing shell command N+ times in a row.
    streak: list[ShellCommandEntry] = []
    for e in entries:
        if isinstance(e, ShellCommandEntry) and _entry_severity(e, error_ids) == SeverityTier.ATTENTION.value:
            if streak and streak[-1].command != e.command:
                streak = []
            streak.append(e)
            if len(streak) == STUCK_REPEAT_THRESHOLD:
                markers.append({
                    "ts": e.timestamp,
                    "lane_id": lane_id,
                    "kind": "stuck",
                    "severity": SeverityTier.ATTENTION.value,
                    "label": f"command failed {STUCK_REPEAT_THRESHOLD}+ times in a row",
                    "detail": _clip(e.command, _PREVIEW_CHARS),
                    "source": "synthesizer",
                })
        elif isinstance(e, ShellCommandEntry):
            streak = []
    return markers


def _lane_events(lane_id: str, entries: list[TranscriptEntry]) -> list[dict]:
    events: list[dict] = []
    error_ids = _error_result_ids(entries)
    for e in entries:
        if _is_prompt(e):
            events.append({
                "ts": e.timestamp, "lane_id": lane_id, "kind": "user_prompt",
                "label": _clip(e.text, _LABEL_CHARS),
                "severity": SeverityTier.INFO.value, "entry_id": e.id,
            })
        elif isinstance(e, UserMessageEntry) and (e.text or "").strip().startswith(_INTERRUPT_PREFIX):
            events.append({
                "ts": e.timestamp, "lane_id": lane_id, "kind": "interrupt",
                "label": "user interrupt",
                "severity": SeverityTier.NOTABLE.value, "entry_id": e.id,
            })
        elif isinstance(e, SkillCallEntry):
            failed = e.tool_use_id in error_ids
            events.append({
                "ts": e.timestamp, "lane_id": lane_id,
                "kind": "skill_fail" if failed else "skill_load",
                "label": e.skill_name,
                "severity": SeverityTier.ATTENTION.value if failed else SeverityTier.INFO.value,
                "entry_id": e.id,
            })
        elif isinstance(e, AgentSpawnEntry):
            events.append({
                "ts": e.timestamp, "lane_id": lane_id, "kind": "agent_spawn",
                "label": _clip(e.description or e.agent_type, _LABEL_CHARS),
                "severity": SeverityTier.INFO.value, "entry_id": e.id,
            })
    return events


def _lane_dict(
    lane_id: str,
    kind: str,
    transcript: AgentTranscriptFile,
    entries: list[TranscriptEntry],
    *,
    agent_type: str | None = None,
    description: str | None = None,
    parent_lane_id: str | None = None,
    spawn_tool_use_id: str | None = None,
) -> tuple[dict, list[dict], list[dict]]:
    stamped = [e.timestamp for e in entries if e.timestamp]
    lane = {
        "id": lane_id,
        "kind": kind,
        "agent_type": agent_type,
        "description": description,
        "parent_lane_id": parent_lane_id,
        "spawn_tool_use_id": spawn_tool_use_id,
        "start_ts": stamped[0] if stamped else None,
        "end_ts": stamped[-1] if stamped else None,
        "segments": _segments(lane_id, entries, transcript),
    }
    return lane, _lane_events(lane_id, entries), _lane_markers(lane_id, entries)


def _subagent_files(jsonl_path: Path, session_id: str) -> list[tuple[Path, dict]]:
    """(agent jsonl, parsed meta) pairs under ``<dir>/<sid>/subagents/``."""
    sub_dir = jsonl_path.parent / session_id / "subagents"
    if not sub_dir.is_dir():
        return []
    out: list[tuple[Path, dict]] = []
    for meta_path in sorted(sub_dir.glob("agent-*.meta.json")):
        jsonl = meta_path.with_name(meta_path.name.replace(".meta.json", ".jsonl"))
        if not jsonl.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        out.append((jsonl, meta if isinstance(meta, dict) else {}))
    return out


def synthesize_agent_trace(session_id: str, worker_type: str = "claude") -> dict:
    path = resolve_session_jsonl(worker_type, session_id)
    transcript = AgentTranscriptFile(worker_type, path, session_id=session_id)
    root_entries = [e for e in transcript.entries if not e.is_sidechain]

    lanes: list[dict] = []
    events: list[dict] = []
    markers: list[dict] = []
    total_cost = transcript.cost()

    lane, ev, mk = _lane_dict("root", "root", transcript, root_entries)
    lanes.append(lane)
    events.extend(ev)
    markers.extend(mk)

    spawns_by_tuid = {
        e.tool_use_id: e
        for e in transcript.entries
        if isinstance(e, AgentSpawnEntry) and e.tool_use_id
    }
    for jsonl, meta in _subagent_files(path, transcript.session_id or session_id):
        sub = AgentTranscriptFile(worker_type, jsonl)
        if not sub.entries:
            continue
        lane_id = jsonl.stem  # agent-<id>
        spawn = spawns_by_tuid.get(meta.get("toolUseId") or "")
        lane, ev, mk = _lane_dict(
            lane_id, "subagent", sub, list(sub.entries),
            agent_type=meta.get("agentType") or (spawn.agent_type if spawn else None),
            description=meta.get("description") or (spawn.description if spawn else None),
            parent_lane_id="root",
            spawn_tool_use_id=meta.get("toolUseId"),
        )
        lanes.append(lane)
        events.extend(ev)
        markers.extend(mk)
        total_cost += sub.cost()

    all_ms = [m for lane in lanes for m in (_ts_ms(lane["start_ts"] or ""), _ts_ms(lane["end_ts"] or "")) if m]
    tool_call_count = sum(len(s["tool_calls"]) for lane in lanes for s in lane["segments"])

    return {
        "version": 1,
        "id": None,  # adopted/minted at entity create / first index
        "name": f"trace-{(transcript.session_id or session_id)[:8]}",
        "session_id": transcript.session_id or session_id,
        "worker_type": worker_type,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "verdict": None,
            "verdict_reason": None,
            "duration_ms": (max(all_ms) - min(all_ms)) if all_ms else 0,
            "cost_usd": round(total_cost, 4),
            "issue_count": sum(1 for m in markers if m["kind"] in ("issue", "stuck")),
            "divergence_count": 0,
            "lane_count": len(lanes),
            "tool_call_count": tool_call_count,
        },
        "lanes": lanes,
        "events": sorted(events, key=lambda e: e["ts"] or ""),
        "markers": sorted(markers, key=lambda m: m["ts"] or ""),
        "annotations": {"goals": [], "divergences": [], "verdict": None, "notes": []},
        "source_path": str(path),
    }


def merge_annotations(skeleton: dict, annotations: dict) -> dict:
    """Fold the skill's judgment layer into a synthesized skeleton.

    ``annotations`` carries: ``goals`` (each {label, lane_id?, start_ts,
    end_ts, subgoals?, verdict?}), ``divergences`` / ``issues`` (each {ts,
    lane_id?, label, detail?, severity?}), ``verdict`` ("ok"|"mixed"|"bad"),
    ``verdict_reason``, ``notes``. Skill-sourced markers are appended (never
    replacing synthesizer ones) and the summary counts are recomputed.
    """
    trace = json.loads(json.dumps(skeleton))  # deep copy, JSON-safe
    goals = annotations.get("goals") or []
    divergences = annotations.get("divergences") or []
    issues = annotations.get("issues") or []
    trace["annotations"] = {
        "goals": goals,
        "divergences": divergences,
        "verdict": annotations.get("verdict"),
        "notes": annotations.get("notes") or [],
    }
    for kind, items in (("divergence", divergences), ("issue", issues)):
        for item in items:
            trace["markers"].append({
                "ts": item.get("ts") or item.get("start_ts") or "",
                "lane_id": item.get("lane_id") or "root",
                "kind": kind,
                "severity": item.get("severity") or SeverityTier.NOTABLE.value,
                "label": item.get("label") or "",
                "detail": item.get("detail") or "",
                "source": "skill",
            })
    trace["markers"].sort(key=lambda m: m["ts"] or "")
    summary = trace["summary"]
    summary["verdict"] = annotations.get("verdict")
    summary["verdict_reason"] = annotations.get("verdict_reason")
    summary["issue_count"] = sum(1 for m in trace["markers"] if m["kind"] in ("issue", "stuck"))
    summary["divergence_count"] = sum(1 for m in trace["markers"] if m["kind"] == "divergence")
    return trace


def _main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="AgentTrace skeleton synthesizer")
    ap.add_argument("session_id", nargs="?", help="worker session id")
    ap.add_argument("--worker", default="claude")
    ap.add_argument("--merge", nargs=2, metavar=("SKELETON", "ANNOTATIONS"),
                    help="merge an annotations file into a skeleton file")
    ap.add_argument("--out", help="output path (default: stdout)")
    args = ap.parse_args()

    if args.merge:
        skeleton = json.loads(Path(args.merge[0]).read_text(encoding="utf-8"))
        annotations = json.loads(Path(args.merge[1]).read_text(encoding="utf-8"))
        result = merge_annotations(skeleton, annotations)
    elif args.session_id:
        result = synthesize_agent_trace(args.session_id, args.worker)
    else:
        ap.error("provide a session_id or --merge SKELETON ANNOTATIONS")
        return

    text = json.dumps(result, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
        summary = result["summary"]
        print(f"wrote {args.out}: lanes={summary['lane_count']} "
              f"tool_calls={summary['tool_call_count']} issues={summary['issue_count']} "
              f"cost=${summary['cost_usd']}")
    else:
        print(text)


if __name__ == "__main__":
    _main()
