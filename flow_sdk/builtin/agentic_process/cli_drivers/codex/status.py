"""Derive ``WorkerStatus`` from a tee'd Codex event JSONL transcript.

The codex worker writes the same JSONL it streams over stdout into a
process-local file (``<record_dir>/codex_transcript.jsonl``). This module
reads the tail of that file and maps it to the shared ``WorkerStatus`` enum
so the rest of AgenticProcess (``is_ready_for_input``, ``stream_transcript``)
can reason about codex sessions without caring which CLI produced them.

Logger namespace: ``flow_sdk.builtin.agentic_process.cli_drivers.codex.status``.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from flow_sdk.fs_records.agent_status import WorkerStatus

logger = logging.getLogger(__name__)

_TAIL_BYTES = 4096
_ACTIVE_SECONDS = 300


def codex_tail_status(path: str | Path) -> WorkerStatus:
    """Map the tail of a codex JSONL transcript to a WorkerStatus.

    The contract matches ``flow_sdk.fs_records.agent_status._tail_status``
    so callers can swap one for the other based on ``worker_type`` without
    touching downstream consumers.
    """
    p = Path(path)
    try:
        stat = p.stat()
    except OSError:
        return WorkerStatus.INITIALIZING

    is_active = (time.time() - stat.st_mtime) <= _ACTIVE_SECONDS

    try:
        sz = stat.st_size
        with open(p, "rb") as f:
            if sz > _TAIL_BYTES:
                f.seek(sz - _TAIL_BYTES)
            chunk = f.read().decode("utf-8", errors="replace")
    except OSError:
        return WorkerStatus.INITIALIZING

    last_event_type: str | None = None
    last_item_type: str | None = None
    saw_turn_completed = False
    saw_error = False

    for line in reversed(chunk.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = entry.get("type")
        if etype == "turn.completed":
            saw_turn_completed = True
            if last_event_type is None:
                last_event_type = etype
            break
        if etype == "error":
            saw_error = True
            if last_event_type is None:
                last_event_type = etype
            break
        if last_event_type is None:
            last_event_type = etype
            item = entry.get("item") or {}
            if isinstance(item, dict):
                last_item_type = item.get("type")

    if saw_turn_completed:
        return WorkerStatus.COMPLETE
    if saw_error:
        return WorkerStatus.ERROR

    if not is_active:
        return WorkerStatus.INACTIVE

    if last_event_type == "item.started":
        if last_item_type == "command_execution":
            return WorkerStatus.TOOL_RUNNING
        if last_item_type in {"file_change", "agent_message"}:
            return WorkerStatus.TOOL_CALL
        return WorkerStatus.THINKING
    if last_event_type == "turn.started":
        return WorkerStatus.WAITING
    if last_event_type == "thread.started":
        return WorkerStatus.INITIALIZING
    if last_event_type is None:
        return WorkerStatus.INITIALIZING
    return WorkerStatus.THINKING
