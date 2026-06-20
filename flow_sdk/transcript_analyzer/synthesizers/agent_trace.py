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
                   label, detail, skill, section_hint, source: synthesizer|skill}],
      "annotations": {goals: [], divergences: [], issues: [], verdict, notes: [],
                      by_skill: {<skill>: {skill, findings: [{kind, ts, label, detail,
                        section_hint, evidence, severity, judged_against,
                        unresolved_anchors}]}}, unattributed: []}
    }

CLI (what the agent-trace skill runs)::

    uv run python -m flow_sdk.transcript_analyzer.synthesizers.agent_trace \
        <session_id> [--worker claude] [--out skeleton.json]
    uv run python -m flow_sdk.transcript_analyzer.synthesizers.agent_trace \
        --merge skeleton.json annotations.json [--out trace.json]
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from ..callable_taxonomy import classify_callable
from ..entries import (
    AgentSpawnEntry,
    CompactionEntry,
    MetaEntry,
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

# Idle gap that splits a skill's outline lane into separate active-burst bars
# (so a skill that ran several times hours apart shows several short bars, not
# one span from first-seen to last-seen).
_SKILL_BURST_GAP_S = 300

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
# Other synthetic user rows Claude Code injects that are NOT human turns: slash-
# command scaffolding and background task-completion notifications. A real prompt
# never opens with one of these tags.
_SYNTHETIC_USER_PREFIXES = (
    _SKILL_INJECTION_PREFIX,
    "<task-notification>",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<local-command-stdout>",
    "<local-command-caveat>",
)

# Read-only probe kinds (Read / Grep / Glob / search). A *failed* probe is
# expected exploration noise — the agent looked something up that wasn't there —
# not a real "issue", so it must not raise severity or mint an issue marker.
# WEB_FETCH is deliberately NOT here: a fetch failure (network/site down) may be
# a real problem, not a benign lookup miss.
_PROBE_KINDS = frozenset({EntryKind.FILE_READ, EntryKind.SEARCH})


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
    # Failed if it has a non-zero exit, a folded-in result error flag (Claude
    # Bash results carry no exitCode), or a separate is_error result row.
    failed = (
        getattr(e, "exit_code", None) not in (None, 0)
        or getattr(e, "is_error", False)
        or getattr(e, "tool_use_id", "") in error_ids
    )
    if not failed:
        return SeverityTier.INFO.value
    # A failed read-only probe (Read / Grep / Glob) is expected exploration noise
    # — looking up something that wasn't there — not a real issue.
    if e.kind in _PROBE_KINDS:
        return SeverityTier.INFO.value
    return SeverityTier.ATTENTION.value


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
    # Slash-command scaffolding, task-completion notifications, skill injections —
    # injected by Claude Code, not human turns.
    if text.startswith(_SYNTHETIC_USER_PREFIXES):
        return False
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


def _outline_span(lane_id: str, start_ts: str | None, end_ts: str | None, label: str, severity: str = "info") -> dict:
    """One full-width span segment for an outline lane (skill/subagent/plan)."""
    return {
        "id": f"{lane_id}:0",
        "start_ts": start_ts,
        "end_ts": end_ts or start_ts,
        "label": _clip(label, _LABEL_CHARS),
        "cost_usd": 0.0,
        "severity": severity,
        "tool_calls": [],
    }


def _outline_lane(
    lane_id: str,
    kind: str,
    depth: int,
    *,
    start_ts: str | None = None,
    end_ts: str | None = None,
    segments: list[dict] | None = None,
    events: list[dict] | None = None,
    markers: list[dict] | None = None,
    agent_type: str | None = None,
    description: str | None = None,
    skill_name: str | None = None,
    parent_lane_id: str | None = None,
    spawn_tool_use_id: str | None = None,
) -> dict:
    """One ``TraceLane``-shaped outline lane (root/tasks/skill/subagent)."""
    return {
        "id": lane_id, "kind": kind, "depth": depth,
        "agent_type": agent_type, "description": description, "skill_name": skill_name,
        "parent_lane_id": parent_lane_id, "spawn_tool_use_id": spawn_tool_use_id,
        "start_ts": start_ts, "end_ts": end_ts,
        "segments": segments or [], "events": events or [], "markers": markers or [],
    }


def _bursts(times: list[str], gap_s: float) -> list[tuple[str, str]]:
    """Contiguous active windows over sorted timestamps — a new window starts
    when the gap to the previous timestamp exceeds ``gap_s``."""
    out: list[list[str]] = []
    for ts in times:
        ms = _ts_ms(ts)
        if ms is None:
            continue
        prev_ms = _ts_ms(out[-1][1]) if out else None
        if out and prev_ms is not None and (ms - prev_ms) <= gap_s * 1000:
            out[-1][1] = ts
        else:
            out.append([ts, ts])
    return [(a, b) for a, b in out]


def _event_lane(name: str, events: list[dict]) -> dict | None:
    """A session-level outline lane that is just a list of point events
    (``user`` / ``tasks`` / ``errors``), spanning its first→last event timestamp.
    Events are sorted by ``ts``; returns ``None`` when empty. ``name`` is the
    lane id, kind, and label (all three coincide for these structural lanes)."""
    evs = sorted(events, key=lambda e: e.get("ts") or "")
    ts = [e["ts"] for e in evs if e.get("ts")]
    if not ts:
        return None
    return _outline_lane(
        name, name, 1, description=name, parent_lane_id="root",
        start_ts=ts[0], end_ts=ts[-1], events=evs,
    )


def _build_outline(
    root_entries: list[TranscriptEntry],
    sub_lane_by_tuid: dict[str, dict],
    markers: list[dict],
) -> list[dict]:
    """High-level, timeline-ready "session call stack": root → skills →
    subagents, nested by the authoritative ``attribution_skill`` (the real
    multi-turn owner — not the per-turn skill stack the call tree uses). The
    un-nestable progress — plan-mode spans and user interrupts — rides the root
    lane. No tool-level detail; this is the coarse "what ran, under whom" view.

    Each lane is ``TraceLane``-shaped plus ``depth``/``kind`` and carries its own
    ``events``/``markers`` so the timeline renders it standalone. Lanes come back
    in pre-order (root, then each skill followed by its subagents) so the front
    end can indent by ``depth`` directly.
    """
    # One ordered pass collecting each skill's attributed timestamps (raw, NOT
    # gap-filled — see _bursts below: an intermittent skill must render as
    # several short bars at its actual active windows, not one span from
    # first-seen to last-seen, else a skill that ran 4× over 11h looks like a
    # 12h run). permission-mode entries carry NO timestamp, so plan spans +
    # tasks borrow the nearest preceding timestamp.
    skill_ts: dict[str, list[str]] = {}
    plan_spans: list[tuple[str, str]] = []
    user_events: list[dict] = []  # prompts + interrupts (the "user" lane)
    task_events: list[dict] = []
    last_ts: str | None = None
    plan_open: str | None = None

    for e in root_entries:
        sk = getattr(e, "attribution_skill", None)
        if e.timestamp:
            last_ts = e.timestamp
        ts = e.timestamp or last_ts

        if sk and ts:
            skill_ts.setdefault(sk, []).append(ts)

        if isinstance(e, MetaEntry) and e.meta_kind == "permission-mode":
            mode = (e.payload or {}).get("permissionMode")
            if mode == "plan" and plan_open is None:
                plan_open = ts
            elif mode != "plan" and plan_open is not None and ts:
                plan_spans.append((plan_open, ts))
                plan_open = None
        elif isinstance(e, UserMessageEntry) and ts:
            text = (e.text or "").strip()
            if text.startswith(_INTERRUPT_PREFIX):
                user_events.append({
                    "ts": ts, "lane_id": "user", "kind": "interrupt",
                    "label": "user interrupt", "severity": SeverityTier.ATTENTION.value, "entry_id": e.id,
                })
            elif _is_prompt(e):
                user_events.append({
                    "ts": ts, "lane_id": "user", "kind": "user_prompt",
                    "label": _clip(text, _LABEL_CHARS), "severity": SeverityTier.INFO.value, "entry_id": e.id,
                })
        elif isinstance(e, ToolUseEntry) and getattr(e, "tool_name", "") in ("TaskCreate", "TaskUpdate") and ts:
            ti = getattr(e, "tool_input", None) or {}
            if e.tool_name == "TaskCreate":
                task_events.append({
                    "ts": ts, "lane_id": "tasks", "kind": "task_create",
                    "label": _clip(str(ti.get("subject") or "task"), _LABEL_CHARS),
                    "severity": SeverityTier.INFO.value, "entry_id": e.id,
                })
            else:
                status = str(ti.get("status") or "updated")
                task_events.append({
                    "ts": ts, "lane_id": "tasks", "kind": "task_update",
                    "label": _clip(f"{ti.get('subject') or 'task'} → {status}", _LABEL_CHARS),
                    "severity": SeverityTier.NOTABLE.value if status == "completed" else SeverityTier.INFO.value,
                    "entry_id": e.id,
                })

    for v in skill_ts.values():
        v.sort()
    skill_order = sorted(skill_ts, key=lambda s: skill_ts[s][0])
    skill_lane_id = {sk: f"skill-{i}" for i, sk in enumerate(skill_order)}
    skill_bursts = {sk: _bursts(skill_ts[sk], _SKILL_BURST_GAP_S) for sk in skill_order}
    all_ts = [t for v in skill_ts.values() for t in v] or [e.timestamp for e in root_entries if e.timestamp]
    session_start = min(all_ts) if all_ts else None
    session_end = max(all_ts) if all_ts else None
    if plan_open is not None and session_end:
        plan_spans.append((plan_open, session_end))

    root_lane = _outline_lane(
        "root", "root", 0, description="session",
        start_ts=session_start, end_ts=session_end,
        segments=[_outline_span("root", s, en, "plan mode", SeverityTier.NOTABLE.value) for s, en in plan_spans],
    )

    # Subagent lanes, attributed to the skill that owned the spawn.
    agents_by_owner: dict[str | None, list[dict]] = {}
    for i, sp in enumerate(e for e in root_entries if isinstance(e, AgentSpawnEntry)):
        owner = getattr(sp, "attribution_skill", None)
        parent = skill_lane_id.get(owner, "root")
        lid = f"agent-{i}"
        sub = sub_lane_by_tuid.get(sp.tool_use_id or "")
        start_ts = (sub.get("start_ts") if sub else None) or sp.timestamp
        end_ts = (sub.get("end_ts") if sub else None) or sp.timestamp
        label = sp.description or sp.agent_type or "agent"
        agents_by_owner.setdefault(owner, []).append(_outline_lane(
            lid, "subagent", 2 if parent != "root" else 1,
            agent_type=sp.agent_type, description=sp.description,
            parent_lane_id=parent, spawn_tool_use_id=sp.tool_use_id,
            start_ts=start_ts, end_ts=end_ts,
            segments=[_outline_span(lid, start_ts, end_ts, label)],
        ))

    # Session-level event lanes under root, in order: the human's prompts +
    # interrupts; the TaskCreate/TaskUpdate todo list; and the errors lane —
    # every failed tool call / stuck loop (issue + stuck markers from the whole
    # session incl. subagents, so it agrees with the header's issue count;
    # rendered red, and only shown by the front end in advanced mode).
    error_events = [
        {
            "ts": m["ts"], "lane_id": "errors", "kind": "error",
            "label": m.get("label") or "error",
            "severity": SeverityTier.ATTENTION.value, "entry_id": "",
        }
        for m in markers
        if m.get("kind") in ("issue", "stuck") and m.get("ts")
    ]
    out: list[dict] = [root_lane]
    for lane in (
        _event_lane("user", user_events),
        _event_lane("tasks", task_events),
        _event_lane("errors", error_events),
    ):
        if lane:
            out.append(lane)
    for sk in skill_order:
        bursts = skill_bursts[sk]
        lid = skill_lane_id[sk]
        out.append(_outline_lane(
            lid, "skill", 1, description=sk, skill_name=sk, parent_lane_id="root",
            start_ts=bursts[0][0] if bursts else None,
            end_ts=bursts[-1][1] if bursts else None,
            # One bar per active burst — gaps between runs stay empty so an
            # intermittent skill doesn't read as one long continuous run.
            segments=[_outline_span(lid, b0, b1, sk) for b0, b1 in bursts],
        ))
        out.extend(sorted(agents_by_owner.get(sk, []), key=lambda x: x["start_ts"] or ""))
    out.extend(sorted(agents_by_owner.get(None, []), key=lambda x: x["start_ts"] or ""))
    return out


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
    # High-level "session call stack" lanes — built from the authoritative
    # attribution_skill (NOT call_tree), spanning all spawns incl. in-flight.
    sub_lane_by_tuid = {l["spawn_tool_use_id"]: l for l in lanes if l.get("spawn_tool_use_id")}
    outline = _build_outline(root_entries, sub_lane_by_tuid, markers)

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
        "outline": outline,
        "events": sorted(events, key=lambda e: e["ts"] or ""),
        "markers": sorted(markers, key=lambda m: m["ts"] or ""),
        "annotations": {
            "goals": [], "divergences": [], "issues": [], "verdict": None,
            "notes": [], "by_skill": {}, "unattributed": [],
        },
        "source_path": str(path),
    }


def _injected_skill_name(text: str) -> str | None:
    """The skill name from a `Base directory for this skill: <path>` injection —
    the base directory's last path component is the skill folder name."""
    first = text.splitlines()[0] if text else ""
    path = first[len(_SKILL_INJECTION_PREFIX):].strip()
    return Path(path).name or None if path else None


def loaded_skill_bodies(transcript: AgentTranscriptFile) -> dict[str, str]:
    """Recover the SKILL bodies **actually loaded at runtime**, keyed by skill name.

    When a skill is invoked, Claude injects a synthetic user message carrying the
    skill's text (prefixed ``Base directory for this skill:``). That body is what
    the run actually followed — which can differ from the current on-disk SKILL.md.
    Judging a finding against this (not on-disk) is what keeps finding and fix
    referring to the same artifact. First load of each skill wins.
    """
    bodies: dict[str, str] = {}
    for e in transcript.entries:
        if not isinstance(e, UserMessageEntry):
            continue
        text = (e.text or "").lstrip()
        if not text.startswith(_SKILL_INJECTION_PREFIX):
            continue
        name = _injected_skill_name(text)
        if name and name not in bodies:
            bodies[name] = text
    return bodies


def _skill_dir(skill: str) -> Path | None:
    for base in (Path.cwd() / ".claude" / "skills", Path.home() / ".claude" / "skills"):
        d = base / skill
        if d.is_dir():
            return d
    return None


def _read_disk_skill_entry(skill: str) -> str | None:
    """Current on-disk SKILL.md (the entry file) — the basis for drift compare."""
    d = _skill_dir(skill)
    if not d:
        return None
    try:
        return (d / "SKILL.md").read_text(encoding="utf-8")
    except OSError:
        return None


def _read_disk_skill_corpus(skill: str) -> str | None:
    """The whole on-disk skill folder (SKILL.md + every routed `.md`) concatenated.
    Anchor resolution checks this, since a `section_hint` may point at a routed file
    (e.g. `modes/qa-cycle.md`), not just the entry SKILL.md."""
    d = _skill_dir(skill)
    if not d:
        return None
    parts = []
    for f in sorted(d.rglob("*.md")):
        try:
            parts.append(f.read_text(encoding="utf-8"))
        except OSError:
            continue
    return "\n".join(parts) if parts else None


def _norm_text(s: str | None) -> str:
    return " ".join((s or "").split()).lower()


def _quoted_tokens(s: str) -> list[str]:
    """The 'quoted' / "quoted" anchor substrings inside a section_hint — the
    resolvable bits we can mechanically check against the skill body."""
    return [m.group(2) for m in re.finditer(r"(['\"])(.+?)\1", s or "") if m.group(2).strip()]


def _hash(s: str) -> str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()


def validate_findings(trace: dict) -> None:
    """Deterministic, always-on checks on attributed findings (mutates ``trace``).

    For each finding in ``annotations.by_skill``: stamp ``judged_against``
    (``loaded`` when the run's SKILL body was recovered from the transcript, else
    ``disk``) and ``unresolved_anchors`` — the section_hint quotes that resolve
    NOWHERE in the skill text (loaded body ∪ the whole on-disk folder), i.e. a
    stale anchor citing a string that no longer exists. Per-skill
    ``summary.skill_drift`` flags where the loaded entry body differs from on-disk
    SKILL.md. These FLAG findings (never drop) — the LLM verify step and skillit
    decide what to do with the flag.
    """
    ann = trace.get("annotations") or {}
    by_skill = ann.get("by_skill") or {}
    if not by_skill:
        return
    bodies: dict[str, str] = {}
    src = trace.get("source_path")
    if src:
        try:
            t = AgentTranscriptFile(trace.get("worker_type", "claude"), Path(src))
            bodies = loaded_skill_bodies(t)
        except Exception:
            bodies = {}
    drift: dict[str, bool] = {}
    for skill, bucket in by_skill.items():
        loaded = bodies.get(skill)
        disk_entry = _read_disk_skill_entry(skill)
        findings = bucket.get("findings", [])
        judged = "loaded" if loaded is not None else ("disk" if disk_entry is not None else "none")
        if loaded is not None and disk_entry is not None:
            drift[skill] = _hash(loaded) != _hash(disk_entry)
        # Anchor resolution: a token must exist SOMEWHERE in the skill — the loaded
        # body or any on-disk file — to count as resolvable. Only read the (whole-
        # folder) corpus when some finding actually carries quoted anchors.
        corpus = ""
        if any(_quoted_tokens(f.get("section_hint", "")) for f in findings):
            corpus = _norm_text("\n".join(p for p in (loaded, _read_disk_skill_corpus(skill)) if p))
        for f in findings:
            f["judged_against"] = judged
            toks = _quoted_tokens(f.get("section_hint", ""))
            if corpus and toks:
                f["unresolved_anchors"] = [tk for tk in toks if _norm_text(tk) not in corpus]
    if drift:
        trace.setdefault("summary", {})["skill_drift"] = drift


def project_findings_by_skill(
    divergences: list[dict], issues: list[dict]
) -> tuple[dict[str, dict], list[dict]]:
    """Group skill-attributable findings by the skill (asset) they implicate.

    Each finding may carry ``skill`` (the name of the loaded skill it's about)
    and ``section_hint`` (where in that skill's files the fix likely belongs).
    Findings that name a ``skill`` are bucketed under it — the **per-asset**
    input skillit's correct mode consumes, one skill per run, already shaped
    like its fixer's finding (label/detail + a section anchor). Findings with no
    ``skill`` are session-level (goal drift, wrong conclusions) and stay in
    ``unattributed`` for the human — they are nobody's skill defect.
    """
    by_skill: dict[str, dict] = {}
    unattributed: list[dict] = []
    for kind, items in (("divergence", divergences), ("issue", issues)):
        for it in items:
            finding = {
                "kind": kind,
                "ts": it.get("ts") or it.get("start_ts") or "",
                "label": it.get("label") or "",
                "detail": it.get("detail") or "",
                "section_hint": it.get("section_hint") or "",
                "evidence": it.get("evidence") or {},
                "severity": it.get("severity") or SeverityTier.NOTABLE.value,
            }
            skill = it.get("skill")
            if skill:
                by_skill.setdefault(skill, {"skill": skill, "findings": []})["findings"].append(finding)
            else:
                unattributed.append(finding)
    return by_skill, unattributed


def merge_annotations(skeleton: dict, annotations: dict) -> dict:
    """Fold the skill's judgment layer into a synthesized skeleton.

    ``annotations`` carries: ``goals`` (each {label, lane_id?, start_ts,
    end_ts, subgoals?, verdict?}), ``divergences`` / ``issues`` (each {ts,
    lane_id?, label, detail?, severity?, skill?, section_hint?, evidence?}),
    ``verdict`` ("ok"|"mixed"|"bad"), ``verdict_reason``, ``notes``. Skill-sourced
    markers are appended (never replacing synthesizer ones), the per-asset
    ``by_skill`` / ``unattributed`` projection is computed, the summary counts are
    recomputed, and :func:`validate_findings` stamps ``judged_against`` /
    ``unresolved_anchors`` / ``summary.skill_drift`` on the result.
    """
    trace = json.loads(json.dumps(skeleton))  # deep copy, JSON-safe
    goals = annotations.get("goals") or []
    divergences = annotations.get("divergences") or []
    issues = annotations.get("issues") or []
    by_skill, unattributed = project_findings_by_skill(divergences, issues)
    trace["annotations"] = {
        "goals": goals,
        "divergences": divergences,
        "issues": issues,
        "verdict": annotations.get("verdict"),
        "notes": annotations.get("notes") or [],
        "by_skill": by_skill,
        "unattributed": unattributed,
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
                "skill": item.get("skill") or "",
                "section_hint": item.get("section_hint") or "",
                "source": "skill",
            })
    trace["markers"].sort(key=lambda m: m["ts"] or "")
    summary = trace["summary"]
    summary["verdict"] = annotations.get("verdict")
    summary["verdict_reason"] = annotations.get("verdict_reason")
    summary["issue_count"] = sum(1 for m in trace["markers"] if m["kind"] in ("issue", "stuck"))
    summary["divergence_count"] = sum(1 for m in trace["markers"] if m["kind"] == "divergence")
    validate_findings(trace)
    return trace


def _main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="AgentTrace skeleton synthesizer")
    ap.add_argument("session_id", nargs="?", help="worker session id")
    ap.add_argument("--worker", default="claude")
    ap.add_argument("--merge", nargs=2, metavar=("SKELETON", "ANNOTATIONS"),
                    help="merge an annotations file into a skeleton file")
    ap.add_argument("--loaded-skills", action="store_true",
                    help="dump {skill_name: loaded SKILL body} recovered from the "
                         "session transcript (the verify step grades against this)")
    ap.add_argument("--out", help="output path (default: stdout)")
    args = ap.parse_args()

    if args.loaded_skills:
        if not args.session_id:
            ap.error("--loaded-skills needs a session_id")
            return
        path = resolve_session_jsonl(args.worker, args.session_id)
        transcript = AgentTranscriptFile(args.worker, path, session_id=args.session_id)
        print(json.dumps(loaded_skill_bodies(transcript), indent=2))
        return

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
