"""Convert Codex CLI ``codex exec --json`` events into FlowData.

Mirrors ``claude_event_to_flowdata.convert_event`` for the Codex JSONL stream
format. Each line of the stream is a JSON object discriminated by ``type``.

Confirmed empirically against codex 0.118.0 — the events seen on a run are:

    {"type":"thread.started","thread_id":"<uuid>"}
    {"type":"turn.started"}
    {"type":"item.started","item":{"id":"item_N","type":"agent_message"|"command_execution"|"file_change", ...}}
    {"type":"item.completed","item":{...}}
    {"type":"turn.completed","usage":{...}}

This converter is intentionally separate from ``claude_event_to_flowdata`` so
the Codex event taxonomy can evolve independently of Claude's stream-json.

Logger namespace: ``flow_sdk.builtin.agentic_workers.codex_event_to_flowdata``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)


def convert_event(event: dict[str, Any]) -> list[FlowData]:
    """Map a single codex JSON event to zero or more FlowData items.

    Unknown event types yield a defensive ``<flow-status subtype="unknown">``
    so the wire stream stays continuous.
    """
    etype = event.get("type")

    if etype == "thread.started":
        return [_status("thread-started", event.get("thread_id") or "")]
    if etype == "turn.started":
        return [_status("turn-started")]
    if etype == "turn.completed":
        return _convert_turn_completed(event)
    if etype == "item.started":
        return _convert_item(event.get("item") or {}, completed=False)
    if etype == "item.completed":
        return _convert_item(event.get("item") or {}, completed=True)
    if etype == "error":
        return [_error(_safe_dump(event))]

    return [_status("unknown", _safe_dump(event))]


def convert_line(line: str) -> list[FlowData]:
    """Parse one JSON line and convert it. Empty/invalid lines yield []."""
    line = line.strip()
    if not line:
        return []
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        logger.debug("codex_event_to_flowdata: non-JSON line: %r", line[:200])
        return []
    if not isinstance(event, dict):
        return []
    return convert_event(event)


def final_end_frame() -> FlowData:
    """The terminal ``<flow-end>`` frame. Emit after the subprocess settles."""
    return FlowData(
        flow_value="",
        attributes={
            "element-type": FlowElementType.END,
            "data-type": FlowDataType.TEXT,
        },
    )


# ── Per-event converters ──────────────────────────────────────────────────────


def _convert_turn_completed(event: dict[str, Any]) -> list[FlowData]:
    usage = event.get("usage") or {}
    attrs: dict[str, str] = {
        "element-type": FlowElementType.RESULT,
        "data-type": FlowDataType.OBJECT,
        "outcome": "success",
        "subtype": "turn_completed",
    }
    return [
        FlowData(flow_value={"usage": usage}, attributes=attrs),
        final_end_frame(),
    ]


def _convert_item(item: dict[str, Any], *, completed: bool) -> list[FlowData]:
    itype = item.get("type")

    if itype == "agent_message":
        # Only emit text once — when the message item completes — to avoid
        # duplicate CHAT entries during partial-streaming interim events.
        if not completed:
            return []
        text = item.get("text") or ""
        if not text:
            return []
        return [FlowData(
            flow_value=text,
            attributes={
                "element-type": FlowElementType.CHAT,
                "data-type": FlowDataType.TEXT,
                "role": "assistant",
            },
        )]

    if itype == "command_execution":
        cmd = item.get("command") or ""
        out = item.get("aggregated_output") or ""
        exit_code = item.get("exit_code")
        if not completed:
            return [FlowData(
                flow_value={"command": cmd},
                attributes={
                    "element-type": FlowElementType.TOOL_CALL,
                    "data-type": FlowDataType.OBJECT,
                    "tool-name": "shell",
                },
            )]
        return [FlowData(
            flow_value={"command": cmd, "output": out, "exit_code": exit_code},
            attributes={
                "element-type": FlowElementType.TOOL_RESULT,
                "data-type": FlowDataType.OBJECT,
                "tool-name": "shell",
            },
        )]

    if itype == "file_change":
        changes = item.get("changes") or []
        if not completed:
            return [FlowData(
                flow_value={"changes": changes},
                attributes={
                    "element-type": FlowElementType.TOOL_CALL,
                    "data-type": FlowDataType.OBJECT,
                    "tool-name": "file_change",
                },
            )]
        return [FlowData(
            flow_value={"changes": changes, "status": item.get("status")},
            attributes={
                "element-type": FlowElementType.TOOL_RESULT,
                "data-type": FlowDataType.OBJECT,
                "tool-name": "file_change",
            },
        )]

    return [_status("item-unknown", _safe_dump(item))]


# ── Helpers ───────────────────────────────────────────────────────────────────


def _status(subtype: str, value: str = "") -> FlowData:
    return FlowData(
        flow_value=value,
        attributes={
            "element-type": FlowElementType.STATUS,
            "data-type": FlowDataType.TEXT,
            "subtype": subtype,
        },
    )


def _error(msg: str) -> FlowData:
    return FlowData(
        flow_value=msg,
        attributes={
            "element-type": FlowElementType.ERROR,
            "data-type": FlowDataType.TEXT,
        },
    )


def _safe_dump(obj: Any) -> str:
    try:
        return json.dumps(obj, default=str)[:400]
    except (TypeError, ValueError):
        return str(obj)[:400]
