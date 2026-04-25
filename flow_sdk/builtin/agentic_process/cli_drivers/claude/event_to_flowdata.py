"""Convert Claude CLI ``--output-format stream-json`` events into FlowData.

Each line of the stream is a JSON object with a ``type`` discriminator.
We map them onto the existing FlowElementType taxonomy so downstream surfaces
(ChatMessage, ArtifactSection, useProcessStream, etc.) render without any
knowledge of where the events came from.

Event schema confirmed empirically by ``scripts/verify_stream_json.py`` against
Claude CLI 2.1.116. Shapes match the JSONL transcript shapes used by
``session_history.py`` for the ``assistant``/``user`` content blocks — the
per-block mapping is duplicated here deliberately so the live converter has no
runtime dependency on the history loader.
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


# ── Public API ────────────────────────────────────────────────────────────────


def convert_event(event: dict[str, Any]) -> list[FlowData]:
    """Map a single stream-json event to zero or more FlowData items.

    Never raises on malformed input — unknown/unparseable events become a
    defensive ``<flow-status subtype="unknown">`` so the stream stays intact.
    """
    etype = event.get("type")

    if etype == "system":
        return _convert_system(event)
    if etype == "assistant":
        return _convert_assistant(event)
    if etype == "user":
        return _convert_user(event)
    if etype == "rate_limit_event":
        return [_status("rate-limit", _safe_dump(event))]
    if etype == "result":
        return _convert_result(event)

    # Unknown event — surface it rather than drop.
    return [_status("unknown", _safe_dump(event))]


def convert_line(line: str) -> list[FlowData]:
    """Parse one JSON line and convert it. Empty/invalid lines yield []."""
    line = line.strip()
    if not line:
        return []
    try:
        event = json.loads(line)
    except json.JSONDecodeError:
        logger.debug("claude_event_to_flowdata: non-JSON line: %r", line[:200])
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


def _convert_system(event: dict[str, Any]) -> list[FlowData]:
    subtype = event.get("subtype") or "system"
    # Keep the raw JSON in the value for debugging; UI surfaces the subtype.
    return [_status(subtype, _safe_dump(event))]


def _convert_assistant(event: dict[str, Any]) -> list[FlowData]:
    message = event.get("message") or {}
    blocks = message.get("content") or []
    out: list[FlowData] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text = block.get("text") or ""
            if text:
                out.append(FlowData(
                    flow_value=text,
                    attributes={
                        "element-type": FlowElementType.CHAT,
                        "data-type": FlowDataType.TEXT,
                        "role": "assistant",
                    },
                ))
        elif btype == "thinking":
            thinking = block.get("thinking") or ""
            if thinking:
                out.append(FlowData(
                    flow_value=thinking,
                    attributes={
                        "element-type": FlowElementType.REASONING,
                        "data-type": FlowDataType.TEXT,
                    },
                ))
        elif btype == "tool_use":
            out.append(FlowData(
                flow_value={
                    "tool_name": block.get("name"),
                    "tool_call_id": block.get("id"),
                    "args": block.get("input"),
                },
                attributes={
                    "element-type": FlowElementType.TOOL_CALL,
                    "data-type": FlowDataType.OBJECT,
                    "tool-name": str(block.get("name") or ""),
                },
            ))
        # Silently ignore unknown block types — harmless, keeps the stream moving.
    return out


def _convert_user(event: dict[str, Any]) -> list[FlowData]:
    message = event.get("message") or {}
    blocks = message.get("content") or []
    out: list[FlowData] = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "tool_result":
            out.append(FlowData(
                flow_value={
                    "tool_call_id": block.get("tool_use_id"),
                    "content": block.get("content"),
                },
                attributes={
                    "element-type": FlowElementType.TOOL_RESULT,
                    "data-type": FlowDataType.OBJECT,
                    "tool-use-id": str(block.get("tool_use_id") or ""),
                },
            ))
    return out


def _convert_result(event: dict[str, Any]) -> list[FlowData]:
    subtype = event.get("subtype") or "unknown"
    outcome = "success" if subtype == "success" else "error"
    attrs: dict[str, str] = {
        "element-type": FlowElementType.RESULT,
        "data-type": FlowDataType.OBJECT,
        "outcome": outcome,
        "subtype": str(subtype),
    }
    # Surface cost / usage when available.
    cost = event.get("total_cost_usd")
    if cost is not None:
        attrs["cost-usd"] = str(cost)
    return [
        FlowData(
            flow_value={k: event.get(k) for k in ("subtype", "total_cost_usd", "usage", "result", "duration_ms") if k in event},
            attributes=attrs,
        ),
        final_end_frame(),
    ]


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


def _safe_dump(obj: Any) -> str:
    try:
        return json.dumps(obj, default=str)[:400]
    except (TypeError, ValueError):
        return str(obj)[:400]
