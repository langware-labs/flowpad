"""Derive WorkerStatus from a Deep Agents transcript tail (the runner's own event vocabulary)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.transcript_tail_status import tail_status
from flow_sdk.transcript_analyzer.worker_status import WorkerStatus


def deepagents_tail_status(path: str | Path) -> WorkerStatus:
    """This vendor's classifier over the shared JSONL tail scanner."""
    return tail_status(path, _classify)


def _classify(raw: dict[str, Any]) -> tuple[WorkerStatus | None, bool]:
    event_type = str(raw.get("type") or "")

    # FlowPad-synthesized terminals (the worker writes these into its own tee).
    if event_type == "flowpad.interrupted":
        return WorkerStatus.INTERRUPTED, True
    if event_type == "flowpad.error":
        return WorkerStatus.ERROR, True

    if event_type == "result":
        return (WorkerStatus.ERROR if raw.get("is_error") else WorkerStatus.COMPLETE), True
    if event_type == "error":
        # Non-terminal on its own — the runner's ``result`` follows and decides.
        return WorkerStatus.ERROR, False

    if event_type == "tool_call":
        return WorkerStatus.TOOL_CALL, False
    if event_type in {"tool_result", "text", "reasoning", "usage"}:
        # The tool returned / a block landed; the model is composing the next step.
        return WorkerStatus.THINKING, False
    if event_type == "user":
        return WorkerStatus.WORKING, False
    if event_type == "init":
        return WorkerStatus.INITIALIZING, False
    return None, False
