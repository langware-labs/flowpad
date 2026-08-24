"""Derive ``WorkerStatus`` from Codex JSONL transcript tails.

Codex has two transcript shapes:

* process-local stream events from ``codex exec --json`` headless turns
  (``thread.started``, ``turn.started``, ``item.started``, ``turn.completed``);
* global Codex rollout files from visible/open interactive sessions under
  ``~/.codex/sessions/**/rollout-*.jsonl`` (``session_meta``,
  ``turn_context``, ``response_item``, ``event_msg``).

This module reads only the tail of either file and maps common signals to the
shared ``WorkerStatus`` enum so AgenticProcess has one consolidated worker
status path across Codex execution modes.

Logger namespace: ``flow_sdk.builtin.agentic_process.cli_drivers.codex.status``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.transcript_tail_status import tail_status
from flow_sdk.builtin.worker_status import WorkerStatus

logger = logging.getLogger(__name__)


_TOOL_CALL_ITEMS = {
    "function_call",
    "custom_tool_call",
    "local_shell_call",
    "tool_call",
    "web_search_call",
    "tool_search_call",
}

_TOOL_OUTPUT_ITEMS = {
    "function_call_output",
    "custom_tool_call_output",
    "local_shell_call_output",
    "tool_output",
    "tool_search_output",
}

_TOOL_BEGIN_EVENTS = {
    "exec_command_begin",
    "mcp_tool_call_begin",
    "patch_apply_begin",
}

_TOOL_END_EVENTS = {
    "exec_command_end",
    "mcp_tool_call_end",
    "patch_apply_end",
}

_COMPLETE_EVENTS = {
    "turn.completed",
    "task_complete",
}

_INTERRUPTED_EVENTS = {
    "turn_aborted",
}


def codex_tail_status(path: str | Path) -> WorkerStatus:
    """Codex's classifier over the shared JSONL tail scanner.

    Terminal evidence wins even for stale files. Non-terminal evidence is
    reported only while the file is fresh; once the writer is stale, the worker
    is considered inactive rather than idle.
    """
    return tail_status(path, _classify_codex_entry)


def _classify_codex_entry(raw: dict[str, Any]) -> tuple[WorkerStatus | None, bool]:
    """Return ``(status, terminal)`` for one Codex JSONL envelope."""
    rtype = _as_str(raw.get("type")) or ""

    # Process-local stream-event shape.
    if rtype == "turn.completed":
        return WorkerStatus.COMPLETE, True
    if rtype in {"error", "turn.failed", "item.failed"}:
        return WorkerStatus.ERROR, True
    if rtype in {"turn.aborted", "interrupt"}:
        return WorkerStatus.INTERRUPTED, True
    if rtype == "thread.started":
        return WorkerStatus.INITIALIZING, False
    if rtype == "turn.started":
        return WorkerStatus.WORKING, False
    if rtype == "item.started":
        item = raw.get("item") if isinstance(raw.get("item"), dict) else {}
        item_type = _as_str(item.get("type")) or ""
        if item_type == "command_execution":
            return WorkerStatus.TOOL_RUNNING, False
        if item_type in {"file_change", "agent_message"}:
            return WorkerStatus.TOOL_CALL, False
        return WorkerStatus.THINKING, False
    if rtype == "item.completed":
        return WorkerStatus.THINKING, False

    # Codex rollout shape.
    if rtype == "event_msg":
        payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
        event_type = _as_str(payload.get("type")) or ""
        if event_type in _COMPLETE_EVENTS:
            return WorkerStatus.COMPLETE, True
        if event_type in _INTERRUPTED_EVENTS:
            return WorkerStatus.INTERRUPTED, True
        if "error" in event_type:
            return WorkerStatus.ERROR, True
        if event_type in _TOOL_BEGIN_EVENTS or event_type.endswith("_begin"):
            return WorkerStatus.TOOL_RUNNING, False
        if event_type in _TOOL_END_EVENTS or event_type.endswith("_end"):
            return WorkerStatus.THINKING, False
        if event_type == "task_started":
            return WorkerStatus.WORKING, False
        return None, False

    if rtype == "response_item":
        payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
        item_type = _as_str(payload.get("type")) or ""
        role = _as_str(payload.get("role")) or ""
        phase = _as_str(payload.get("phase")) or ""
        if item_type == "message":
            if role == "user":
                return WorkerStatus.WORKING, False
            if role in {"assistant", "developer"}:
                if phase == "final_answer":
                    return WorkerStatus.COMPLETE, True
                return WorkerStatus.THINKING, False
        if item_type in _TOOL_CALL_ITEMS:
            return WorkerStatus.TOOL_CALL, False
        if item_type in _TOOL_OUTPUT_ITEMS:
            return WorkerStatus.THINKING, False
        if item_type == "reasoning":
            return WorkerStatus.THINKING, False
        return None, False

    if rtype in {"turn_context", "session_meta"}:
        return WorkerStatus.INITIALIZING, False
    if rtype in {"token_count", "compacted"}:
        return None, False
    return None, False


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None
