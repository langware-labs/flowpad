"""Load a Codex session JSONL transcript as a list of FlowData.

Mirrors ``session_history.load_session_history`` for codex.

Two transcript locations are searched, in order:

1. The process-local file the Codex worker tee'd to:
   ``<records_root>/agentic_process/<stem>/codex_transcript.jsonl``
   This is the file the codex worker wrote in ``--ephemeral`` mode and the
   one ``stream_transcript`` tails.

2. As a fallback, the user's ``~/.codex/sessions/**/rollout-*.jsonl`` index,
   matching the thread_id that the codex worker captured into
   ``AgenticProcess.session_id``. Used when the worker ran without
   ``--ephemeral``.

Logger namespace: ``flow_sdk.builtin.agentic_process.cli_drivers.codex.session_history``.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer import AgentTranscriptFile, EntryKind
from flow_sdk.transcript_analyzer.process_entry import ProcessEntry

logger = logging.getLogger(__name__)
_LAUNCH_LOOKBACK = timedelta(seconds=30)


def _parse_iso_datetime(value: object) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _normalize_path(value: object) -> str | None:
    if not value:
        return None
    try:
        return str(Path(str(value)).expanduser().resolve())
    except OSError:
        return str(Path(str(value)).expanduser())


def codex_transcript_path_for_process(process_id: str) -> Path:
    """Return the canonical process-local transcript path for codex.

    Lazily imported to avoid pulling Record machinery at module import time.
    """
    from flow_sdk.fs_store.record_paths import shadow_dir_for

    d = shadow_dir_for("agentic_process", process_id)
    d.mkdir(parents=True, exist_ok=True)
    return d / "codex_transcript.jsonl"


def find_codex_session_jsonl(thread_id: str) -> Path | None:
    """Locate a codex session JSONL by thread_id under ``~/.codex/sessions/``.

    Codex names files ``rollout-<timestamp>-<thread_id>.jsonl``; we just
    glob-search for the suffix.
    """
    from flow_sdk.instance_settings import get_instance_settings
    sessions_root = get_instance_settings().codex_sessions_dir
    if not sessions_root.is_dir():
        return None
    suffix = f"-{thread_id}.jsonl"
    for p in sessions_root.rglob("rollout-*.jsonl"):
        if p.name.endswith(suffix):
            return p
    return None


def read_codex_rollout_meta(path: Path) -> dict:
    """Return the leading rollout ``session_meta`` payload plus timestamp."""
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                raw = json.loads(line)
                if raw.get("type") != "session_meta":
                    return {}
                payload = raw.get("payload") or {}
                if not isinstance(payload, dict):
                    return {}
                return {
                    **payload,
                    "_path": str(path),
                    "_timestamp": raw.get("timestamp") or payload.get("timestamp") or "",
                }
    except (OSError, json.JSONDecodeError):
        return {}
    return {}


def find_latest_codex_session_jsonl(
    *,
    cwd: str | None,
    started_at: str | datetime | None = None,
) -> Path | None:
    """Find the newest rollout matching cwd and, when available, launch time."""
    normalized_cwd = _normalize_path(cwd)
    if not normalized_cwd:
        return None
    from flow_sdk.instance_settings import get_instance_settings

    sessions_root = get_instance_settings().codex_sessions_dir
    if not sessions_root.is_dir():
        return None

    launch_dt = _parse_iso_datetime(started_at)
    matches: list[tuple[datetime, Path]] = []
    for path in sessions_root.rglob("rollout-*.jsonl"):
        meta = read_codex_rollout_meta(path)
        if _normalize_path(meta.get("cwd")) != normalized_cwd:
            continue
        raw_dt = _parse_iso_datetime(meta.get("_timestamp") or meta.get("timestamp"))
        if raw_dt is None:
            try:
                raw_dt = datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc)
            except OSError:
                continue
        if launch_dt is not None and raw_dt < launch_dt - _LAUNCH_LOOKBACK:
            continue
        matches.append((raw_dt, path))
    if not matches:
        return None
    matches.sort(key=lambda item: item[0], reverse=True)
    return matches[0][1]


def load_session_history(session_id: str, process_id: str | None = None) -> list[FlowData]:
    """Load codex session history as FlowData.

    Args:
        session_id: The codex thread id captured by the worker.
        process_id: AgenticProcess id whose process-local transcript to read.
                    If omitted, falls back to ``~/.codex/sessions/`` lookup.

    Returns:
        Empty list if no transcript can be found — never raises.
    """
    transcript: Path | None = None
    if process_id:
        candidate = codex_transcript_path_for_process(process_id)
        if candidate.exists():
            transcript = candidate
    if transcript is None and session_id:
        transcript = find_codex_session_jsonl(session_id)
    if transcript is None or not transcript.exists():
        return []

    return load_transcript_history(transcript)


def load_transcript_history(transcript: Path) -> list[FlowData]:
    """Load a Codex transcript through the canonical typed parser.

    ``AgentTranscriptFile`` is per-line tolerant — a malformed JSONL line is
    skipped, not fatal — so reaching this except means the rollout as a whole
    could not be parsed (a parser bug or an unreadable/foreign format). That
    is worth a WARNING, and the caller gets a structured ERROR frame instead
    of a silently-empty history.
    """
    history: list[FlowData] = []
    try:
        parsed = AgentTranscriptFile("codex", transcript)
    except Exception as exc:
        logger.warning("Codex history parse failed for %s", transcript, exc_info=True)
        return [FlowData(
            flow_value=f"Failed to parse codex transcript {transcript}: {exc}",
            attributes={
                "element-type": FlowElementType.ERROR,
                "data-type": FlowDataType.TEXT,
                "subtype": "history-parse-error",
                "observation-kind": "replay",
            },
        )]

    for entry in parsed.entries:
        # Session metadata and unknown parser fallbacks are discovery/debug
        # details, not durable conversation rows.
        if entry.kind in (EntryKind.META, EntryKind.UNKNOWN):
            continue
        history.extend(_entry_to_replay_flow_data(entry))

    return history


# ── Per-entry conversion ───────────────────────────────────────────────────────


_TOOL_USE_KINDS = frozenset({
    "tool_use",
    "shell_command",
    "file_write",
    "file_edit",
    "file_read",
    "skill_call",
    "search",
    "web_fetch",
    "todo_update",
    "agent_spawn",
    "exit_plan_mode",
})


def _entry_to_replay_flow_data(entry) -> list[FlowData]:
    process_entry = ProcessEntry(
        transcript_entry=entry,
        observation_kind="replay",
    ).to_dict()
    frames = entry.to_flow_data()
    if not frames:
        # Entries whose ``to_flow_data()`` is deliberately empty (SYSTEM,
        # TOKEN_USAGE) still get one STATUS frame — the live stream does the
        # same (see ``event_to_flowdata._wrap_live``), so replay stays
        # row-for-row comparable with what a live subscriber saw.
        frames = [FlowData(
            flow_value={},
            created_time=entry.timestamp or "",
            attributes={
                "element-type": _element_type_for_kind(entry.kind.value),
                "data-type": FlowDataType.OBJECT,
            },
        )]

    # SYSTEM entries carry a refined subtype (``turn_context``,
    # ``event_msg.error``, ...) that is strictly more informative than the
    # generic kind tag — surface it instead.
    subtype = entry.kind.value
    if entry.kind is EntryKind.SYSTEM and getattr(entry, "subtype", None):
        subtype = str(entry.subtype)

    for frame in frames:
        frame.process_entry = process_entry
        frame.attributes["subtype"] = subtype
        # Vendor-neutral abort signal: a rollout's organic turn_aborted event
        # (written by the codex TUI on Ctrl-C) means every still-unmatched tool
        # call of that turn is terminated, exactly like a flowpad-authored
        # cancel marker (turn_abort.py). Stamp the shared attribute so the UI
        # keys on semantics, not the vendor event name.
        if subtype == "event_msg.turn_aborted":
            frame.attributes["turn-terminated"] = "true"
        frame.attributes["observation-kind"] = "replay"
        frame.attributes.setdefault("transcript-entry-id", entry.id)
        if entry.entry_id:
            frame.attributes.setdefault("transcript-source-entry-id", entry.entry_id)
        phase = getattr(entry, "phase", None)
        if phase:
            frame.attributes.setdefault("phase", str(phase))
    return frames


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
