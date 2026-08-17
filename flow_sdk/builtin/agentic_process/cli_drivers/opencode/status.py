"""Derive WorkerStatus from OpenCode JSONL transcript tails.

Both FlowPad-owned formats share one line vocabulary (the stdout stream's
envelope), so this classifier serves the headless tee and the store projection
alike.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from flow_sdk.builtin.worker_status import WorkerStatus

_TAIL_BYTES = 64 * 1024
_ACTIVE_SECONDS = 300


def opencode_tail_status(path: str | Path) -> WorkerStatus:
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
    part = raw.get("part") if isinstance(raw.get("part"), dict) else {}

    # FlowPad-synthesized terminals (the worker writes these into its own tee).
    if event_type == "flowpad.interrupted":
        return WorkerStatus.INTERRUPTED, True
    if event_type == "flowpad.error":
        return WorkerStatus.ERROR, True
    if event_type == "flowpad.result":
        exit_code = raw.get("exitCode")
        return (WorkerStatus.COMPLETE if exit_code in (0, None) else WorkerStatus.ERROR), True

    if event_type == "error":
        return WorkerStatus.ERROR, True

    if event_type == "step_finish":
        reason = str(part.get("reason") or "")
        if reason == "stop":
            # The turn ended cleanly. Terminal: it must beat a stale mtime.
            return WorkerStatus.COMPLETE, True
        # "tool-calls" (and any future reason) means the loop continues.
        return WorkerStatus.THINKING, False

    if event_type == "tool_use":
        state = part.get("state") if isinstance(part.get("state"), dict) else {}
        status = str(state.get("status") or "")
        if status == "completed":
            # The tool returned; the model is composing the next step.
            return WorkerStatus.THINKING, False
        if status in {"running", "pending"}:
            return WorkerStatus.TOOL_RUNNING, False
        return WorkerStatus.TOOL_CALL, False

    if event_type in {"text", "reasoning"}:
        return WorkerStatus.THINKING, False
    if event_type == "flowpad.user_prompt":
        return WorkerStatus.WORKING, False
    if event_type == "step_start":
        return WorkerStatus.INITIALIZING, False
    return None, False
