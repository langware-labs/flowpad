"""Load Claude session history as FlowData carrying typed ProcessEntries.

Replaces the old per-block reshape — now delegates to ``AgentTranscript``
(canonical parser) and wraps each entry in a
``ProcessEntry(observation_kind='replay')`` riding on
``FlowData.process_entry``.

Public API preserved:
    - ``get_session_jsonl_path(session_id)`` — path lookup
    - ``load_session_history(session_id)``  — list[FlowData]
"""

from __future__ import annotations

import logging
from pathlib import Path

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer import AgentTranscript
from flow_sdk.transcript_analyzer.process_entry import ProcessEntry
from flow_sdk.transcript_analyzer.resolver import (
    TranscriptNotFoundError,
    resolve_session_jsonl,
)

logger = logging.getLogger(__name__)


_TOOL_USE_KINDS = frozenset({
    "tool_use", "shell_command", "file_write", "file_edit", "file_read",
    "search", "web_fetch", "todo_update", "agent_spawn", "exit_plan_mode",
})


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


def load_session_history(session_id: str) -> list[FlowData]:
    """Load session history as FlowData carrying typed ProcessEntries."""
    try:
        path = resolve_session_jsonl("claude", session_id)
    except TranscriptNotFoundError:
        logger.warning("load_session_history: no JSONL for session %s", session_id)
        return []
    try:
        transcript = AgentTranscript("claude", path)
    except Exception:
        logger.exception("load_session_history: parse failed for %s", path)
        return []
    return [_wrap_replay(e) for e in transcript.entries]


def _wrap_replay(entry) -> FlowData:
    pe = ProcessEntry(transcript_entry=entry, observation_kind="replay")
    return FlowData(
        flow_value={},
        created_time=entry.timestamp or "",
        attributes={
            "element-type": _element_type_for_kind(entry.kind.value),
            "data-type": FlowDataType.OBJECT,
        },
        process_entry=pe.to_dict(),
    )


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
