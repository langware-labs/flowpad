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

import json
import logging
from pathlib import Path
from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer._helpers import extract_text
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
    kind = entry.kind.value
    attributes = {
        "element-type": _element_type_for_kind(kind),
        "data-type": FlowDataType.OBJECT,
        "subtype": kind,
        "observation-kind": "replay",
    }
    flow_value: Any = {}
    text = getattr(entry, "text", None)
    if kind == "user_message":
        attributes["role"] = getattr(entry, "role", "user")
        if isinstance(text, str):
            flow_value = text
            attributes["data-type"] = FlowDataType.TEXT
    elif kind == "assistant_message":
        attributes["role"] = "assistant"
        if isinstance(text, str):
            flow_value = text
            attributes["data-type"] = FlowDataType.TEXT
    return FlowData(
        flow_value=flow_value,
        created_time=entry.timestamp or "",
        attributes=attributes,
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
