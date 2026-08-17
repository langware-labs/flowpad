"""Derive WorkerStatus from OpenCode JSONL transcript tails.

Both FlowPad-owned formats share one line vocabulary (the stdout stream's
envelope), so this classifier serves the headless tee and the store projection
alike.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.transcript_tail_status import tail_status
from flow_sdk.builtin.worker_status import WorkerStatus



def opencode_tail_status(path: str | Path) -> WorkerStatus:
    """OpenCode's classifier over the shared JSONL tail scanner."""
    return tail_status(path, _classify)


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
