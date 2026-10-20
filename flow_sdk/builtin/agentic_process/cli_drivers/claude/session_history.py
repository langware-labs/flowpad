"""Load Claude session history as FlowData carrying typed ProcessEntries.

Replaces the old per-block reshape — now delegates to ``AgentTranscriptFile``
(canonical parser) and wraps each entry in a
``ProcessEntry(observation_kind='replay')`` riding on
``FlowData.process_entry``.

Public API preserved:
    - ``get_session_jsonl_path(session_id)`` — path lookup
    - ``load_session_history(session_id)``  — list[FlowData]
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.session_paths import parse_iso_datetime
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer import AgentTranscriptFile
from flow_sdk.transcript_analyzer._helpers import extract_text
from flow_sdk.transcript_analyzer.process_entry import ProcessEntry
from flow_sdk.transcript_analyzer.resolver import (
    TranscriptNotFoundError,
    resolve_session_jsonl,
)

logger = logging.getLogger(__name__)


_TOOL_USE_KINDS = frozenset(
    {
        "tool_use",
        "shell_command",
        "flow_command",
        "file_write",
        "file_edit",
        "file_read",
        "search",
        "web_fetch",
        "todo_update",
        "agent_spawn",
        "exit_plan_mode",
        "skill_call",
    }
)


def get_session_jsonl_path(session_id: str, project_path: Path | None = None) -> Path | None:
    """Resolve the JSONL path for a session id. Backwards-compat wrapper
    around the canonical resolver.

    ``project_path`` is ignored — the resolver globs all project folders
    (UUIDs are unique).
    """
    try:
        return resolve_session_jsonl("claude", session_id)
    except TranscriptNotFoundError:
        return None


# ── CronCreate jobs a resumed session gets back ──────────────────────────────────────────────

#: A recurring CronCreate job deletes itself this long after it was created (after one last fire).
CRON_EXPIRY_SECONDS = 7 * 24 * 3600


@dataclass(frozen=True)
class ClaudeCronJob:
    """A CronCreate job the CLI holds. Claude Code runs it; Flowpad only needs to know when it is gone."""

    #: The CLI's job id (``tool_use_result.id``), the key ``CronDelete`` names.
    id: str
    recurring: bool
    #: When the CLI drops the job on its own, epoch seconds: a one-shot after its fire
    #: (``nextFireAt``, which already includes the CLI's jitter), a recurring job at expiry.
    ends_at: float


def content_blocks(event: dict) -> list[dict]:
    message = event.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return [block for block in content if isinstance(block, dict)] if isinstance(content, list) else []


def cron_job_from_result(result: dict, *, seen_at: float) -> ClaudeCronJob | None:
    """A CronCreate result (``{id, recurring, durable, nextFireAt}``) as the job it created."""
    job_id = result.get("id")
    next_fire_at = result.get("nextFireAt")
    if not isinstance(job_id, str) or not job_id or not isinstance(next_fire_at, (int, float)):
        return None
    recurring = bool(result.get("recurring"))
    ends_at = seen_at + CRON_EXPIRY_SECONDS if recurring else next_fire_at / 1000
    return ClaudeCronJob(id=job_id, recurring=recurring, ends_at=ends_at)


def _seen_at(entry: dict, default: float) -> float:
    stamped = parse_iso_datetime(entry.get("timestamp"))
    return stamped.timestamp() if stamped else default


def restored_cron_jobs(path: Path, now: float) -> dict[str, ClaudeCronJob]:
    """The CronCreate jobs ``claude --resume`` restores from this session's transcript.

    The CLI's own rule: every job created and not deleted, except a recurring job past its
    expiry and a one-shot whose fire time has passed. Scans the whole file — a job can be
    days older than the transcript's tail.
    """
    calls: dict[str, str] = {}
    jobs: dict[str, ClaudeCronJob] = {}
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return jobs
    for line in lines:
        # A call names its tool; its result only links back by id (``Cancelled job X.``).
        if "Cron" not in line and not (calls and '"tool_result"' in line):
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if entry.get("type") == "assistant":
            for block in content_blocks(entry):
                if block.get("type") == "tool_use" and block.get("name") in ("CronCreate", "CronDelete"):
                    calls[str(block.get("id"))] = block["name"]
        elif entry.get("type") == "user":
            result = entry.get("toolUseResult")
            if not isinstance(result, dict):
                continue
            for block in content_blocks(entry):
                name = calls.pop(str(block.get("tool_use_id")), None) if block.get("type") == "tool_result" else None
                if name is None or block.get("is_error"):
                    continue
                if name == "CronDelete":
                    jobs.pop(str(result.get("id")), None)
                elif job := cron_job_from_result(result, seen_at=_seen_at(entry, now)):
                    jobs[job.id] = job
    return {job_id: job for job_id, job in jobs.items() if job.ends_at > now}


def _extract_text_content(content: Any) -> str:
    """Legacy helper for flattening Claude message content."""
    if not isinstance(content, (str, list)):
        return ""
    return extract_text(content)


def _load_jsonl(path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    """Read JSONL objects from ``path``; malformed or missing files return what can be read."""
    rows: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                if limit is not None and len(rows) >= limit:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(raw, dict):
                    rows.append(raw)
    except OSError:
        return []
    return rows


def load_session_history(session_id: str) -> list[FlowData]:
    """Load session history as FlowData carrying typed ProcessEntries."""
    path = get_session_jsonl_path(session_id)
    if path is None:
        # Common + benign: a session with no transcript yet (just created, or
        # never produced output). Graceful empty result, not a warning.
        logger.debug("load_session_history: no JSONL for session %s", session_id)
        return []
    try:
        transcript = AgentTranscriptFile("claude", path)
    except Exception:
        logger.exception("load_session_history: parse failed for %s", path)
        return []
    return [fd for e in transcript.entries for fd in entry_to_flowdata(e)]


def _stamp_entry_id(attributes: dict, entry) -> None:
    """Name the transcript entry this frame came from, as an ATTRIBUTE.

    ``process_entry`` already carries the entry, but ``FlowData.to_xml`` writes
    only attributes and content — so a frame that reaches a client over the
    ``observe-turn`` SSE stream arrives with no entry identity at all, and the
    client's ``lastHeldTranscriptEntryId`` can never advance past the last
    entry HISTORY gave it. It then states that stale position on every re-open
    and the stream replays everything since (FLOWPAD-1981).

    ``setdefault`` and the attribute name both match codex's converter, which
    has stamped this all along (``codex/session_history.py``).
    """
    entry_id = getattr(entry, "id", None)
    if entry_id:
        attributes.setdefault("transcript-entry-id", str(entry_id))


def entry_to_flowdata(entry, observation_kind: str = "replay") -> list[FlowData]:
    """Convert one parsed ``TranscriptEntry`` to its UI-renderable FlowData.

    ``observation_kind='replay'`` is the history path; the experimental
    PTY-transcript live stream passes ``'live'`` so consumers can tell the
    two apart while reusing the exact same shape.

    Returns a LIST — usually one item, but an ``assistant_message`` entry
    carrying both non-empty ``text`` and non-empty ``thinking`` (see below)
    yields two: a REASONING frame followed by the CHAT frame it precedes.
    """
    pe = ProcessEntry(transcript_entry=entry, observation_kind=observation_kind)
    kind = entry.kind.value
    # Tool / operation entries carry their structured fields (tool-name,
    # tool_call_id, args/input) via their own ``to_flow_data()`` — delegate so a
    # replayed tool names + pairs with its result exactly like the live stream
    # does. Without this the chat shows a nameless "Using Tool" chip and an
    # orphan "tool result (no matching call)". Messages keep the text path below.
    if kind not in ("user_message", "assistant_message"):
        own = entry.to_flow_data()
        if own:
            fd = own[0]
            fd.attributes.setdefault("data-type", FlowDataType.OBJECT)
            fd.attributes["subtype"] = kind
            fd.attributes["observation-kind"] = observation_kind
            # ``entry.to_flow_data()`` mints its FlowData without a time, so the
            # constructor defaults ``created_time`` to NOW — i.e. parse time, not
            # when the agent did the thing. The message branch below carries the
            # entry's own timestamp; carry it here too, or a replayed tool row
            # sorts by when the transcript happened to be read.
            if entry.timestamp:
                fd.created_time = entry.timestamp
            if getattr(entry, "virtual", False):
                fd.attributes["is-virtual"] = "true"
            _stamp_entry_id(fd.attributes, entry)
            fd.process_entry = pe.to_dict()
            return [fd]

    def _make(element_type: str, value: Any) -> FlowData:
        attrs = {
            "element-type": element_type,
            "data-type": FlowDataType.OBJECT,
            "subtype": kind,
            "observation-kind": observation_kind,
        }
        _stamp_entry_id(attrs, entry)
        if kind == "user_message":
            attrs["role"] = getattr(entry, "role", "user")
            if getattr(entry, "is_meta", False):
                attrs["is-meta"] = "true"
        elif kind == "assistant_message":
            attrs["role"] = "assistant"
        if isinstance(value, str):
            attrs["data-type"] = FlowDataType.TEXT
        return FlowData(
            flow_value=value,
            created_time=entry.timestamp or "",
            attributes=attrs,
            process_entry=pe.to_dict(),
        )

    text = getattr(entry, "text", None)
    if kind == "user_message":
        return [_make(_element_type_for_kind(kind), text if isinstance(text, str) else {})]

    # kind == "assistant_message": text=="" used to win here, silently
    # dropping thinking (FLOWPAD-2133). Folding often merges a thinking-line
    # and a text-line into one entry, so emit both — REASONING before CHAT.
    thinking = getattr(entry, "thinking", None)
    out: list[FlowData] = []
    if isinstance(thinking, str) and thinking:
        out.append(_make(FlowElementType.REASONING, thinking))
    if isinstance(text, str) and (text or not out):
        # `text or not out`: a genuinely empty, thinking-less entry must still
        # produce its one content-free TEXT/`chat` frame (unchanged
        # long-standing behavior — dropping it here would leave `out` empty).
        out.append(_make(_element_type_for_kind(kind), text))
    return out


def _element_type_for_kind(kind: str) -> str:
    if kind == "user_message":
        return FlowElementType.USER_MESSAGE
    if kind == "assistant_message":
        return FlowElementType.CHAT
    if kind in _TOOL_USE_KINDS:
        return FlowElementType.TOOL_CALL
    if kind == "tool_result":
        return FlowElementType.TOOL_RESULT
    return FlowElementType.STATUS
