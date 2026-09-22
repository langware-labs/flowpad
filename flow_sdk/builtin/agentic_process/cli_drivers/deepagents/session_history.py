"""Deep Agents session store + transcript history.

A session is a LangGraph thread, checkpointed by the runner to ONE SQLite file per session id
under the instance's ``deepagents_data_dir``. One file per session is deliberate: two processes
never share a database (no writer contention to ride out), and "can this session be resumed" is
a file check that needs neither the engine nor a connection.

The transcript is the runner's stdout, teed by the stream worker — the store is never projected.
"""

from __future__ import annotations

import logging
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import (
    load_transcript_history as shared_load_transcript_history,
)
from flow_sdk.builtin.agentic_process.cli_drivers.session_paths import transcript_path_for_process
from flow_sdk.external_apis.llm.llm_drivers.flow_data import FlowData
from flow_sdk.transcript_analyzer import TranscriptFormat

from .event_to_flowdata import _element_type_for_kind

logger = logging.getLogger(__name__)


def deepagents_transcript_path_for_process(process_id: str) -> Path:
    return transcript_path_for_process("deepagents", process_id)


def sessions_dir() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return Path(get_instance_settings().deepagents_data_dir) / "sessions"


def checkpoint_db_for_session(session_id: str) -> Path:
    return sessions_dir() / f"{session_id}.sqlite"


def find_deepagents_session(session_id: str) -> str | None:
    """*session_id* when the runner has checkpointed it, else None."""
    if not session_id:
        return None
    try:
        return session_id if checkpoint_db_for_session(session_id).is_file() else None
    except OSError:
        return None


def external_session_ids() -> set[str]:
    """Every checkpointed session id — the hygiene probe's view of the store."""
    try:
        return {path.stem for path in sessions_dir().glob("*.sqlite")}
    except OSError:
        return set()


def load_transcript_history(
    transcript: Path,
    *,
    transcript_format: TranscriptFormat | str | None = None,
) -> list[FlowData]:
    return shared_load_transcript_history(
        "deepagents",
        transcript,
        _element_type_for_kind,
        transcript_format=transcript_format or TranscriptFormat.DEEPAGENTS_STREAM,
        logger=logger,
    )


def load_session_history(session_id: str, process_id: str | None = None) -> list[FlowData]:
    if not process_id:
        return []
    transcript = deepagents_transcript_path_for_process(process_id)
    return load_transcript_history(transcript) if transcript.exists() else []
