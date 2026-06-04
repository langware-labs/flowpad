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
    from flow_sdk.fs_store.fs_record import record_stem
    from flow_sdk.fs_store.record_paths import get_default_records_root

    root = get_default_records_root()
    d = root / "agentic_process" / record_stem("agentic_process", process_id)
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
    """Load a specific Codex transcript file as FlowData."""
    history: list[FlowData] = []
    try:
        with open(transcript, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                history.extend(_entry_to_flow_data(entry))
    except OSError:
        return history

    return history


# ── Per-entry conversion ───────────────────────────────────────────────────────


def _entry_to_flow_data(entry: dict) -> list[FlowData]:
    """Convert a single transcript line to zero or more FlowData items.

    Handles both shapes:
      - process-local stream events (``thread.started`` / ``item.completed`` ...)
      - codex's own ``~/.codex/sessions/`` rollout shape
        (``response_item`` with ``role`` and ``content`` blocks).

    Both shapes carry an outer ISO 8601 ``timestamp`` field per line; we
    forward it as ``created_time`` so the UI timeline reflects the original
    transcript time instead of the get-history call time.
    """
    etype = entry.get("type")
    entry_ts = entry.get("timestamp") or ""

    # ── Process-local stream event shape ──────────────────────────────────────
    if etype == "item.completed":
        item = entry.get("item") or {}
        return _item_to_flow_data(item, entry_ts)

    # ── codex sessions/* rollout shape ────────────────────────────────────────
    if etype == "response_item":
        payload = entry.get("payload") or {}
        return _response_item_to_flow_data(payload, entry_ts)

    return []


def _item_to_flow_data(item: dict, entry_ts: str = "") -> list[FlowData]:
    itype = item.get("type")
    if itype == "agent_message":
        text = item.get("text") or ""
        if not text:
            return []
        return [FlowData(
            flow_value=text,
            created_time=entry_ts,
            attributes={
                "element-type": FlowElementType.CHAT,
                "data-type": FlowDataType.TEXT,
                "role": "assistant",
            },
        )]
    if itype == "command_execution":
        return [FlowData(
            flow_value={
                "command": item.get("command"),
                "output": item.get("aggregated_output"),
                "exit_code": item.get("exit_code"),
            },
            created_time=entry_ts,
            attributes={
                "element-type": FlowElementType.TOOL_RESULT,
                "data-type": FlowDataType.OBJECT,
                "tool-name": "shell",
            },
        )]
    if itype == "file_change":
        return [FlowData(
            flow_value={"changes": item.get("changes")},
            created_time=entry_ts,
            attributes={
                "element-type": FlowElementType.TOOL_RESULT,
                "data-type": FlowDataType.OBJECT,
                "tool-name": "file_change",
            },
        )]
    return []


def _response_item_to_flow_data(payload: dict, entry_ts: str = "") -> list[FlowData]:
    if payload.get("type") != "message":
        return []
    role = payload.get("role")
    content = payload.get("content") or []
    text_parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        if block.get("type") in ("input_text", "output_text"):
            text = block.get("text") or ""
            # Skip codex's own permission/apps/skills/plugins prelude blocks.
            if text and not text.startswith("<"):
                text_parts.append(text)
    text = "\n".join(text_parts).strip()
    if not text:
        return []
    if role == "user":
        return [FlowData(
            flow_value=text,
            created_time=entry_ts,
            attributes={
                "element-type": FlowElementType.USER_MESSAGE,
                "data-type": FlowDataType.TEXT,
                "role": "user",
            },
        )]
    if role in ("assistant", "developer"):
        return [FlowData(
            flow_value=text,
            created_time=entry_ts,
            attributes={
                "element-type": FlowElementType.CHAT,
                "data-type": FlowDataType.TEXT,
                "role": "assistant",
            },
        )]
    return []
