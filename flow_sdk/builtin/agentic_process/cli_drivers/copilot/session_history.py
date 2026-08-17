"""Copilot session/transcript discovery and history loading."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import (
    load_transcript_history as shared_load_transcript_history,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
from flow_sdk.transcript_analyzer import TranscriptFormat

from .event_to_flowdata import _element_type_for_kind

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


def copilot_transcript_path_for_process(process_id: str) -> Path:
    """Return the process-local JSONL tee path for Copilot stdout events."""
    from flow_sdk.fs_store.record_paths import shadow_dir_for

    directory = shadow_dir_for("agentic_process", process_id)
    directory.mkdir(parents=True, exist_ok=True)
    return directory / "copilot_transcript.jsonl"


def copilot_session_state_root() -> Path:
    # Instance configuration, not necessarily ``~/.copilot`` — test sandboxes
    # and isolated instances point it elsewhere. Same source of truth the
    # transcript resolver, watcher and session indexer read, so a redirected
    # home stays visible to all of them (mirrors codex's ``codex_sessions_dir``).
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().copilot_session_state_dir


def copilot_session_events_path(session_id: str) -> Path:
    return copilot_session_state_root() / session_id / "events.jsonl"


def find_copilot_session_jsonl(session_id: str) -> Path | None:
    if not session_id:
        return None
    path = copilot_session_events_path(session_id)
    return path if path.exists() else None


def find_latest_copilot_session_jsonl(
    *,
    cwd: str | None,
    started_at: str | datetime | None = None,
) -> Path | None:
    normalized_cwd = _normalize_path(cwd)
    if not normalized_cwd:
        return None
    root = copilot_session_state_root()
    if not root.is_dir():
        return None

    launch_dt = _parse_iso_datetime(started_at)
    matches: list[tuple[datetime, Path]] = []
    for workspace in root.glob("*/workspace.yaml"):
        session_dir = workspace.parent
        events = session_dir / "events.jsonl"
        if not events.exists():
            continue
        if _normalize_path(_read_workspace_cwd(workspace)) != normalized_cwd:
            continue
        try:
            raw_dt = datetime.fromtimestamp(events.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if launch_dt is not None and raw_dt < launch_dt - _LAUNCH_LOOKBACK:
            continue
        matches.append((raw_dt, events))
    if not matches:
        return None
    matches.sort(key=lambda item: item[0], reverse=True)
    return matches[0][1]


def read_copilot_session_meta(path: Path) -> dict:
    """Best-effort metadata from Copilot workspace.yaml + first JSONL line."""
    session_dir = path.parent
    meta: dict = {"id": session_dir.name, "_path": str(path)}
    cwd = _read_workspace_cwd(session_dir / "workspace.yaml")
    if cwd:
        meta["cwd"] = cwd
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                if not line.strip():
                    continue
                raw = json.loads(line)
                timestamp = raw.get("timestamp")
                if timestamp:
                    meta["_timestamp"] = timestamp
                result = raw.get("result")
                if isinstance(result, dict) and result.get("sessionId"):
                    meta["id"] = result["sessionId"]
                data = raw.get("data")
                if isinstance(data, dict):
                    if data.get("sessionId"):
                        meta["id"] = data["sessionId"]
                    if data.get("cwd") and "cwd" not in meta:
                        meta["cwd"] = data["cwd"]
                break
    except (OSError, json.JSONDecodeError):
        pass
    return meta


def load_session_history(session_id: str, process_id: str | None = None) -> list[FlowData]:
    transcript: Path | None = None
    if process_id:
        candidate = copilot_transcript_path_for_process(process_id)
        if candidate.exists():
            transcript = candidate
    if transcript is None and session_id:
        transcript = find_copilot_session_jsonl(session_id)
    if transcript is None or not transcript.exists():
        return []
    return load_transcript_history(transcript)


def load_transcript_history(
    transcript: Path,
    *,
    transcript_format: TranscriptFormat | str | None = None,
) -> list[FlowData]:
    """This vendor's format guess + mapping over the shared replay envelope."""
    return shared_load_transcript_history(
        "copilot",
        transcript,
        _element_type_for_kind,
        transcript_format=transcript_format or _format_for_path(transcript),
        logger=logger,
    )

def _format_for_path(path: Path) -> TranscriptFormat:
    if "session-state" in path.parts:
        return TranscriptFormat.COPILOT_EVENTS
    return TranscriptFormat.COPILOT_STREAM


def _read_workspace_cwd(path: Path) -> str | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("cwd:"):
            continue
        value = stripped.split(":", 1)[1].strip()
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1]
        return value or None
    return None
