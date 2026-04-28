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
from pathlib import Path

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)


def codex_transcript_path_for_process(process_id: str) -> Path:
    """Return the canonical process-local transcript path for codex.

    Lazily imported to avoid pulling Record machinery at module import time.
    """
    from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord
    from flow_sdk.fs_store.record import get_default_records_root, record_stem

    root = get_default_records_root()
    d = root / AgenticProcessRecord._record_type / record_stem(
        AgenticProcessRecord._record_type, process_id
    )
    d.mkdir(parents=True, exist_ok=True)
    return d / "codex_transcript.jsonl"


def find_codex_session_jsonl(thread_id: str) -> Path | None:
    """Locate a codex session JSONL by thread_id under ``~/.codex/sessions/``.

    Codex names files ``rollout-<timestamp>-<thread_id>.jsonl``; we just
    glob-search for the suffix.
    """
    sessions_root = Path.home() / ".codex" / "sessions"
    if not sessions_root.is_dir():
        return None
    suffix = f"-{thread_id}.jsonl"
    for p in sessions_root.rglob("rollout-*.jsonl"):
        if p.name.endswith(suffix):
            return p
    return None


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
