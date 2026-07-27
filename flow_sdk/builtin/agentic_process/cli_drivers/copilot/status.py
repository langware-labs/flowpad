"""Derive WorkerStatus from Copilot JSONL transcript tails."""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from flow_sdk.builtin.worker_status import WorkerStatus

_TAIL_BYTES = 64 * 1024
_ACTIVE_SECONDS = 300


def copilot_tail_status(path: str | Path) -> WorkerStatus:
    file_path = Path(path)
    try:
        stat = file_path.stat()
    except OSError:
        return WorkerStatus.INITIALIZING

    is_active = (time.time() - stat.st_mtime) <= _ACTIVE_SECONDS
    try:
        size = stat.st_size
        with file_path.open("rb") as handle:
            if size > _TAIL_BYTES:
                handle.seek(size - _TAIL_BYTES)
            chunk = handle.read().decode("utf-8", errors="replace")
    except OSError:
        return WorkerStatus.INITIALIZING

    saw_parseable = False
    for line in reversed(chunk.splitlines()):
        raw_line = line.strip()
        if not raw_line:
            continue
        try:
            raw = json.loads(raw_line)
        except json.JSONDecodeError:
            continue
        if not isinstance(raw, dict):
            continue
        saw_parseable = True
        status, terminal = _classify(raw)
        if status is None:
            continue
        if terminal:
            return status
        return status if is_active else WorkerStatus.INACTIVE

    if not saw_parseable:
        return WorkerStatus.INITIALIZING
    return WorkerStatus.UNKNOWN if is_active else WorkerStatus.INACTIVE


def _classify(raw: dict[str, Any]) -> tuple[WorkerStatus | None, bool]:
    event_type = str(raw.get("type") or "")
    if event_type == "flowpad.interrupted":
        return WorkerStatus.INTERRUPTED, True
    if event_type == "flowpad.error":
        return WorkerStatus.ERROR, True
    if event_type == "result":
        exit_code = raw.get("exitCode")
        return (WorkerStatus.COMPLETE if exit_code in (0, None) else WorkerStatus.ERROR), True
    if event_type == "session.shutdown":
        return WorkerStatus.COMPLETE, True
    if event_type == "tool.execution_complete":
        return WorkerStatus.THINKING, False
    if event_type == "tool.execution_start":
        return WorkerStatus.TOOL_RUNNING, False
    if event_type == "assistant.message":
        data = raw.get("data") if isinstance(raw.get("data"), dict) else {}
        tool_requests = data.get("toolRequests")
        if isinstance(tool_requests, list) and tool_requests:
            return WorkerStatus.TOOL_CALL, False
        if data.get("content"):
            return WorkerStatus.THINKING, False
        return WorkerStatus.THINKING, False
    if event_type in {
        "assistant.message_delta",
        "assistant.reasoning",
        "assistant.reasoning_delta",
        "assistant.turn_start",
    }:
        return WorkerStatus.THINKING, False
    if event_type == "assistant.turn_end":
        # The assistant finished its turn (all tool calls for the turn happen
        # BEFORE this marker). The PTY worker stays alive at its prompt, ready
        # for the next user message — so this is IDLE, not THINKING. Mapping it
        # to THINKING pinned a completed copilot session as perpetually busy
        # (status pill stuck, queue drain blocked, chat composer disabled).
        # Non-terminal so an aged session still downgrades to INACTIVE.
        return WorkerStatus.IDLE, False
    if event_type == "user.message":
        return WorkerStatus.WORKING, False
    if event_type.startswith("session.") or event_type == "system.message":
        return WorkerStatus.INITIALIZING, False
    return None, False
