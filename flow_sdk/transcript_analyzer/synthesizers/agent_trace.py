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

from ..callable_taxonomy import classify_callable
from ..entries import (
    AgentSpawnEntry,
    CompactionEntry,
    ShellCommandEntry,
    SkillCallEntry,
    ToolResultEntry,
    ToolUseEntry,
    UserMessageEntry,
)
from ..entry import EntryKind, TranscriptEntry
from ..resolver import resolve_session_jsonl
from ..severity import SEVERITY_RANK, SeverityTier
from ..transcript import AgentTranscriptFile

# Leaf operation kinds in the call tree (no nested context — pure syscalls).
_LEAF_KINDS = frozenset({
    EntryKind.TOOL_USE,
    EntryKind.SHELL_COMMAND,
    EntryKind.FILE_READ,
    EntryKind.FILE_WRITE,
    EntryKind.FILE_EDIT,
    EntryKind.SEARCH,
    EntryKind.WEB_FETCH,
    EntryKind.TODO_UPDATE,
    EntryKind.COMPACTION,
})

def _worst(a: str, b: str) -> str:
    # SeverityTier is a str-Enum, so SEVERITY_RANK (keyed by the enum) resolves
    # plain "attention"/"notable"/"info" strings too.
    return a if SEVERITY_RANK.get(a, 0) >= SEVERITY_RANK.get(b, 0) else b


def _span_ms(start: str | None, end: str | None) -> int:
    a, b = _ts_ms(start or ""), _ts_ms(end or "")
    return (b - a) if (a is not None and b is not None and b >= a) else 0

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
# Claude injects a synthetic user message carrying the skill's SKILL.md when a
# skill is invoked — it's a "user" line but NOT a human turn, so it must not cut
# a segment or reset the call-tree skill stack (else nested skills look sibling).
_SKILL_INJECTION_PREFIX = "Base directory for this skill:"


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
    if not text or text.startswith(_INTERRUPT_PREFIX):
        return False
    if text.startswith(_SKILL_INJECTION_PREFIX):
        return False  # skill-injection message, not a human turn
    return True


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


_CONTAINER_KINDS = frozenset({"session", "skill", "subagent"})


def _make_frame(
    fid: str,
    kind: str,
    callable_name: str,
    lane_id: str,
    *,
    label: str | None = None,
    entry_id: str | None = None,
    policy_kind: str | None = None,
    tool_name: str | None = None,
    start_ts: str | None = None,
    end_ts: str | None = None,
    self_cost_usd: float = 0.0,
    self_duration_ms: int = 0,
    total_duration_ms: int | None = None,
    tool_call_count: int = 0,
    issue_count: int = 0,
    worst_severity: str = "info",
) -> dict:
    """One frame-dict shape for every call-tree node (session/skill/subagent/
    tool/compaction). ``policy_kind`` overrides the kind used for taxonomy
    classification (skill frames classify as ``skill_call``); ``tool_name``
    feeds the MCP flag. ``total_duration_ms`` defaults to the start→end span."""
    return {
        "id": fid,
        "kind": kind,
        "callable": callable_name,
        "label": callable_name if label is None else label,
        "lane_id": lane_id,
        "entry_id": entry_id,
        **classify_callable(policy_kind or kind, tool_name),
        "start_ts": start_ts,
        "end_ts": end_ts,
        "self_cost_usd": self_cost_usd,
        "total_cost_usd": 0.0,
        "self_duration_ms": self_duration_ms,
        "total_duration_ms": _span_ms(start_ts, end_ts) if total_duration_ms is None else total_duration_ms,
        "tool_call_count": tool_call_count,
        "issue_count": issue_count,
        "worst_severity": worst_severity,
        "children": [],
    }


def _compaction_frame(e: TranscriptEntry, lane_id: str, new_id) -> dict:
    """A context-reset checkpoint — kept as its own row (structurally
    significant), not aggregated with tool calls."""
    dur = getattr(e, "duration_ms", None) or 0
    return _make_frame(
        new_id(lane_id), "compaction", "compaction", lane_id,
        label=_clip(_call_preview(e) or "compaction", _LABEL_CHARS),
        entry_id=e.id, start_ts=e.timestamp, end_ts=e.timestamp,
        self_duration_ms=dur, total_duration_ms=dur,
    )


def _build_call_tree(
    lanes: list[dict],
    entries_by_lane: dict,
    transcripts_by_lane: dict,
    markers: list[dict],
) -> dict:
    """Build the nested call stack — **big items only**.

    Container frames: session → skill → subagent. Skills NEST within a turn
    (a skill load opens a frame under the currently-active skill; a user prompt
    closes the skill stack back to the lane), so ``skill1`` calling ``skill2``
    in one turn shows ``skill2`` nested under ``skill1``. Subagent spawns nest
    their whole lane. Individual tool calls are NOT enumerated — they're
    aggregated into one ``tool`` row per tool name (``Bash ×312``) under their
    container; compaction stays an individual checkpoint row. Cost is attributed
    to the deepest active skill over time; markers/efficiency roll up.
    """
    child_by_spawn = {
        l["spawn_tool_use_id"]: l for l in lanes if l.get("spawn_tool_use_id")
    }
    markers_by_lane: dict[str, list[dict]] = {}
    for m in markers:
        markers_by_lane.setdefault(m["lane_id"], []).append(m)

    counter = {"n": 0}

    def new_id(lane_id: str) -> str:
        counter["n"] += 1
        return f"{lane_id}#f{counter['n']}"

    def finalize_container(frame: dict, self_cnt: int, self_worst: str) -> None:
        children = frame["children"]
        frame["total_cost_usd"] = round(
            frame["self_cost_usd"] + sum(c["total_cost_usd"] for c in children), 6
        )
        frame["total_duration_ms"] = frame["total_duration_ms"] or _span_ms(
            frame["start_ts"], frame["end_ts"]
        )
        frame["tool_call_count"] = sum(c["tool_call_count"] for c in children)
        # Issues roll up from MARKERS (canonical, attributed to the deepest
        # active frame) + nested container children only — tool-group rows carry
        # their own attention badge but don't double-count (their failures are
        # already issue markers).
        frame["issue_count"] = self_cnt + sum(
            c["issue_count"] for c in children if c["kind"] in _CONTAINER_KINDS
        )
        worst = self_worst
        for c in children:
            worst = _worst(worst, c["worst_severity"])
        frame["worst_severity"] = worst
        cost, dur, ic = frame["total_cost_usd"], frame["total_duration_ms"], frame["issue_count"]
        frame["issues_per_usd"] = round(ic / cost, 3) if cost and cost > 0 else None
        mins = (dur or 0) / 60000.0
        frame["issues_per_min"] = round(ic / mins, 3) if mins > 0 else None

    def flush_tool_groups(frame: dict, groups: dict, lane_id: str) -> None:
        """Append one aggregated ``tool`` row per tool name to ``frame``."""
        for name, g in sorted(groups.items(), key=lambda kv: -kv[1]["count"]):
            frame["children"].append(_make_frame(
                new_id(lane_id), "tool", name, lane_id,
                label=f"{name} ×{g['count']}", entry_id=g["first_id"], tool_name=name,
                start_ts=g["first_ts"], end_ts=g["last_ts"],
                self_duration_ms=g["dur"], total_duration_ms=g["dur"],
                tool_call_count=g["count"], issue_count=g["attention"], worst_severity=g["worst"],
            ))

    def build_lane_frame(lane: dict, kind: str) -> dict:
        lane_id = lane["id"]
        transcript = transcripts_by_lane.get(lane_id)
        entries = entries_by_lane.get(lane_id, [])
        lane_start, lane_end = lane.get("start_ts"), lane.get("end_ts")
        error_ids = _error_result_ids(entries)
        callable_name = (
            (lane.get("description") or "session")
            if kind == "session"
            else (lane.get("agent_type") or lane_id)
        )
        frame = _make_frame(
            new_id(lane_id), kind, callable_name, lane_id,
            label=_clip(lane.get("description") or callable_name, _LABEL_CHARS),
            start_ts=lane_start, end_ts=lane_end,
        )

        skill_stack: list[dict] = []
        all_skills: list[dict] = []
        # Per-container tool-group accumulators, keyed by frame id.
        tool_groups: dict[str, dict] = {frame["id"]: {}}
        # Cost segments: (start_ts, end_ts, frame_or_lane) for the deepest active
        # skill over time. Boundaries: skill load, turn (user prompt) reset.
        cost_segs: list[tuple] = []
        seg_start = lane_start
        active = frame  # lane frame when no skill open

        def container() -> dict:
            return skill_stack[-1] if skill_stack else frame

        def close_seg(at_ts: str | None) -> None:
            nonlocal seg_start
            if seg_start and at_ts:
                cost_segs.append((seg_start, at_ts, active))
            seg_start = at_ts

        def accumulate_tool(e: TranscriptEntry) -> None:
            cont = container()
            groups = tool_groups.setdefault(cont["id"], {})
            name = getattr(e, "tool_name", "") or e.kind.value
            g = groups.get(name)
            sev = _entry_severity(e, error_ids)
            dur = getattr(e, "duration_ms", None) or 0
            if g is None:
                groups[name] = {
                    "count": 1, "dur": dur, "first_ts": e.timestamp, "last_ts": e.timestamp,
                    "first_id": e.id, "attention": 1 if sev == "attention" else 0, "worst": sev,
                }
            else:
                g["count"] += 1
                g["dur"] += dur
                g["last_ts"] = e.timestamp
                if sev == "attention":
                    g["attention"] += 1
                g["worst"] = _worst(g["worst"], sev)

        for e in entries:
            if _is_prompt(e):
                # Turn boundary — close cost segment, reset the skill stack.
                close_seg(e.timestamp)
                skill_stack = []
                active = frame
            elif isinstance(e, SkillCallEntry):
                close_seg(e.timestamp)
                sk = _make_frame(
                    new_id(lane_id), "skill", e.skill_name, lane_id,
                    label=_clip(f"skill: {e.skill_name}", _LABEL_CHARS),
                    entry_id=e.id, policy_kind="skill_call",
                    start_ts=e.timestamp, end_ts=lane_end, total_duration_ms=0,
                )
                container()["children"].append(sk)  # nest under active skill
                skill_stack.append(sk)
                all_skills.append(sk)
                tool_groups.setdefault(sk["id"], {})
                active = sk
            elif isinstance(e, AgentSpawnEntry):
                child_lane = child_by_spawn.get(e.tool_use_id)
                if child_lane is not None:
                    sub = build_lane_frame(child_lane, "subagent")
                    sub["entry_id"] = e.id
                    container()["children"].append(sub)
                else:
                    accumulate_tool(e)
            elif isinstance(e, CompactionEntry):
                container()["children"].append(_compaction_frame(e, lane_id, new_id))
            elif e.kind in _LEAF_KINDS:
                accumulate_tool(e)

        close_seg(lane_end)

        # Segments tile [lane_start, lane_end] contiguously; attribute cost AND
        # markers to the deepest active frame at each point (no double-count
        # across nested skill windows).
        for s, en, fr in cost_segs:
            if transcript and s and en:
                fr["self_cost_usd"] = round(fr["self_cost_usd"] + transcript.cost_in_span(s, en), 6)

        self_sev_by_frame: dict[str, list[str]] = {}
        for m in markers_by_lane.get(lane_id, []):
            if m["kind"] not in ("issue", "stuck", "divergence"):
                continue
            ts = m["ts"]
            for s, en, fr in cost_segs:
                if s and en and s <= ts <= en:
                    self_sev_by_frame.setdefault(fr["id"], []).append(m["severity"])
                    break

        def self_stats(fid: str) -> tuple[int, str]:
            sevs = self_sev_by_frame.get(fid, [])
            worst = "info"
            for sv in sevs:
                worst = _worst(worst, sv)
            return len(sevs), worst

        # Flush aggregated tool rows, set skill durations.
        for sk in all_skills:
            flush_tool_groups(sk, tool_groups.get(sk["id"], {}), lane_id)
            sk["total_duration_ms"] = _span_ms(sk["start_ts"], sk["end_ts"])
        flush_tool_groups(frame, tool_groups.get(frame["id"], {}), lane_id)

        # Finalize skills deepest-first so parent rollups see child totals.
        for sk in reversed(all_skills):
            finalize_container(sk, *self_stats(sk["id"]))
        finalize_container(frame, *self_stats(frame["id"]))
        return frame

    root_lane = next((l for l in lanes if l["kind"] == "root"), lanes[0] if lanes else None)
    if root_lane is None:
        return {}
    return build_lane_frame(root_lane, "session")


def synthesize_agent_trace(session_id: str, worker_type: str = "claude") -> dict:
    path = resolve_session_jsonl(worker_type, session_id)
    transcript = AgentTranscriptFile(worker_type, path, session_id=session_id)
    root_entries = [e for e in transcript.entries if not e.is_sidechain]

    lanes: list[dict] = []
    events: list[dict] = []
    markers: list[dict] = []
    # Per-lane entries + transcripts so the call tree can attribute cost/markers
    # against the exact transcript each frame draws from.
    entries_by_lane: dict[str, list] = {}
    transcripts_by_lane: dict[str, AgentTranscriptFile] = {}
    total_cost = transcript.cost()

    lane, ev, mk = _lane_dict("root", "root", transcript, root_entries)
    lanes.append(lane)
    events.extend(ev)
    markers.extend(mk)
    entries_by_lane["root"] = root_entries
    transcripts_by_lane["root"] = transcript

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
        entries_by_lane[lane_id] = list(sub.entries)
        transcripts_by_lane[lane_id] = sub
        total_cost += sub.cost()

    all_ms = [m for lane in lanes for m in (_ts_ms(lane["start_ts"] or ""), _ts_ms(lane["end_ts"] or "")) if m]
    tool_call_count = sum(len(s["tool_calls"]) for lane in lanes for s in lane["segments"])
    call_tree = _build_call_tree(lanes, entries_by_lane, transcripts_by_lane, markers)

    return {
        "version": 2,
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
        "call_tree": call_tree,
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
