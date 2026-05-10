"""Load a Codex session JSONL transcript as FlowData carrying typed
ProcessEntries.

Two transcript locations are searched, in order:

1. The process-local file the Codex worker tee'd to:
   ``<records_root>/agentic_process/<stem>/codex_transcript.jsonl``.
2. As a fallback, the user's ``~/.codex/sessions/**/rollout-*.jsonl``
   resolved by ``transcript_analyzer.resolver.resolve_session_jsonl``.

Public API preserved:
    - ``codex_transcript_path_for_process(process_id)`` — process-local path
    - ``find_codex_session_jsonl(thread_id)``           — global glob
    - ``load_session_history(session_id, process_id)``   — list[FlowData]
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


def codex_transcript_path_for_process(process_id: str) -> Path:
    """Return the canonical process-local transcript path for codex."""
    from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
    from flow_sdk.fs_store.record import get_default_records_root, record_stem

    root = get_default_records_root()
    d = root / AgenticProcessRecord._record_type / record_stem(
        AgenticProcessRecord._record_type, process_id
    )
    d.mkdir(parents=True, exist_ok=True)
    return d / "codex_transcript.jsonl"


def find_codex_session_jsonl(thread_id: str) -> Path | None:
    """Glob the user's ~/.codex/sessions/ for the rollout matching this thread."""
    if not thread_id:
        return None
    try:
        return resolve_session_jsonl("codex", thread_id)
    except TranscriptNotFoundError:
        return None


def load_session_history(session_id: str, process_id: str | None = None) -> list[FlowData]:
    """Load codex session history as FlowData carrying typed ProcessEntries."""
    transcript: Path | None = None
    if process_id:
        candidate = codex_transcript_path_for_process(process_id)
        if candidate.exists():
            transcript = candidate
    if transcript is None and session_id:
        transcript = find_codex_session_jsonl(session_id)
    if transcript is None or not transcript.exists():
        return []
    try:
        parsed = AgentTranscript("codex", transcript)
    except Exception:
        logger.exception("codex load_session_history: parse failed for %s", transcript)
        return []
    return [_wrap_replay(e) for e in parsed.entries]


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
