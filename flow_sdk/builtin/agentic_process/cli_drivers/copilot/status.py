"""Derive WorkerStatus from Copilot JSONL transcript tails."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.transcript_tail_status import tail_status
from flow_sdk.builtin.worker_status import WorkerStatus


def copilot_tail_status(path: str | Path) -> WorkerStatus:
    """Copilot's classifier over the shared JSONL tail scanner."""
    return tail_status(path, _classify)


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
