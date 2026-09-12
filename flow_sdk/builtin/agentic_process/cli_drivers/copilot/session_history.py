"""Copilot session/transcript discovery and history loading."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from flow_sdk.assets.types.copilot_meta import _read_workspace_cwd
from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import (
    load_transcript_history as shared_load_transcript_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.session_paths import (
    LAUNCH_LOOKBACK,
    normalize_path,
    parse_iso_datetime,
    transcript_path_for_process,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
from flow_sdk.transcript_analyzer import TranscriptFormat

from .event_to_flowdata import _element_type_for_kind, flowpad_terminal_event_frames

logger = logging.getLogger(__name__)

def copilot_transcript_path_for_process(process_id: str) -> Path:
    """Process-local JSONL tee path for copilot's stdout events."""
    return transcript_path_for_process("copilot", process_id)


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
    normalized_cwd = normalize_path(cwd)
    if not normalized_cwd:
        return None
    root = copilot_session_state_root()
    if not root.is_dir():
        return None

    launch_dt = parse_iso_datetime(started_at)
    matches: list[tuple[datetime, Path]] = []
    for workspace in root.glob("*/workspace.yaml"):
        session_dir = workspace.parent
        events = session_dir / "events.jsonl"
        if not events.exists():
            continue
        if normalize_path(_read_workspace_cwd(workspace)) != normalized_cwd:
            continue
        try:
            raw_dt = datetime.fromtimestamp(events.stat().st_mtime, tz=timezone.utc)
        except OSError:
            continue
        if launch_dt is not None and raw_dt < launch_dt - LAUNCH_LOOKBACK:
            continue
        matches.append((raw_dt, events))
    if not matches:
        return None
    matches.sort(key=lambda item: item[0], reverse=True)
    return matches[0][1]





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
    """This vendor's format guess + mapping over the shared replay envelope.

    ``_terminal_frames`` keeps copilot's own expansion of the ``flowpad.*``
    terminal events its tee writes — those are FlowPad envelopes, not copilot
    entries, so they bypass the standard replay envelope entirely.
    """
    return shared_load_transcript_history(
        "copilot",
        transcript,
        _element_type_for_kind,
        transcript_format=transcript_format or _format_for_path(transcript),
        logger=logger,
        entry_frames=_terminal_frames,
    )


def _terminal_frames(entry, fmt) -> list[FlowData] | None:
    if fmt is not TranscriptFormat.COPILOT_STREAM:
        return None
    return flowpad_terminal_event_frames(getattr(entry, "payload", {}))


def _format_for_path(path: Path) -> TranscriptFormat:
    if "session-state" in path.parts:
        return TranscriptFormat.COPILOT_EVENTS
    return TranscriptFormat.COPILOT_STREAM





def user_turn_count(path: Path) -> int:
    """How many real user turns a Copilot JSONL holds.

    Used to decide which of the two candidate transcripts is authoritative
    (see ``CopilotDriver.transcript_descriptor``). Both the stdout tee and the
    session record speak the same event vocabulary, so ``user.message`` counts
    comparably in either. A file that cannot be read counts as empty, which
    makes the other candidate win rather than raising on a read path.
    """
    count = 0
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line or '"user.message"' not in line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict) and event.get("type") == "user.message":
                    count += 1
    except OSError:
        return 0
    return count
