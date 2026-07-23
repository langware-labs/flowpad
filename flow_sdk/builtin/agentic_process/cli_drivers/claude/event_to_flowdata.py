"""Convert Claude CLI ``--output-format stream-json`` events into FlowData.

Stream-json events share the per-turn envelope shape of JSONL transcript
lines, so we delegate parsing to the canonical ``ClaudeParser`` and wrap
each emitted ``TranscriptEntry`` in a ``ProcessEntry(observation_kind='live')``.
The wrapper rides on ``FlowData.process_entry``; no per-block flattening,
no opaque attribute bags for transcript-shaped events.

Non-conversational events (``system: init``, ``result``, ``rate_limit_event``,
unknown) stay as plain FlowData (status / end frames). Those don't carry a
``process_entry`` payload.
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
from flow_sdk.transcript_analyzer._helpers import flatten_tool_result
from flow_sdk.transcript_analyzer.derive import derive_entry
from flow_sdk.transcript_analyzer.entries import (
    AssistantMessageEntry,
    ToolResultEntry,
    UserMessageEntry,
)
from flow_sdk.transcript_analyzer.parsers.claude import (
    ClaudeParser,
    build_semantic_tool_entry,
)
from flow_sdk.transcript_analyzer.process_entry import ProcessEntry

from .session_history import entry_to_flowdata

logger = logging.getLogger(__name__)


# ── Public API ────────────────────────────────────────────────────────────────


_parser = ClaudeParser()
_line_index = 0


def convert_event(event: dict[str, Any]) -> list[FlowData]:
    """Map a single stream-json event to zero or more FlowData items.

    Conversational events (assistant / user) become FlowData with a typed
    ``process_entry`` payload. Lifecycle events (system, result, rate_limit)
    stay as plain status frames.

    Never raises on malformed input.
    """
    global _line_index

    etype = event.get("type")

    if etype == "assistant":
        try:
            out = _convert_assistant_event(event, _line_index)
        except Exception:
            logger.debug("claude_event_to_flowdata: assistant parse failed", exc_info=True)
            out = [_status("parse-error", _safe_dump(event))]
        _line_index += 1
        return out

    if etype == "user":
        try:
            out = _convert_user_event(event, _line_index)
        except Exception:
            logger.debug("claude_event_to_flowdata: user parse failed", exc_info=True)
            out = [_status("parse-error", _safe_dump(event))]
        _line_index += 1
        return out

    if etype == "system":
        return [_status(event.get("subtype") or "system", _safe_dump(event))]
    if etype == "rate_limit_event":
        return [_status("rate-limit", _safe_dump(event))]
    if etype == "result":
        return _convert_result(event)

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
    """The terminal ``<flow-end>`` frame."""
    return FlowData(
        flow_value="",
        attributes={
            "element-type": FlowElementType.END,
            "data-type": FlowDataType.TEXT,
        },
    )


# ── Internals ─────────────────────────────────────────────────────────────────


def _base_for_event(event: dict[str, Any], line_index: int, block_index: int, fallback: str) -> dict[str, Any]:
    return {
        "id": str(event.get("uuid") or fallback or f"claude-live:{line_index}:{block_index}"),
        "session_id": str(event.get("sessionId") or ""),
        "timestamp": str(event.get("timestamp") or ""),
        "worker": "claude",
        "parent_id": str(event.get("parentUuid") or "") or None,
        "is_sidechain": bool(event.get("isSidechain", False)),
    }


def _content_blocks(event: dict[str, Any]) -> list[Any]:
    message = event.get("message") if isinstance(event.get("message"), dict) else {}
    content = message.get("content") if isinstance(message, dict) else []
    if isinstance(content, list):
        return content
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return []


def _with_process_entry(fd: FlowData, entry) -> FlowData:
    pe = ProcessEntry(transcript_entry=entry, observation_kind="live")
    fd.process_entry = pe.to_dict()
    return fd


def _convert_assistant_event(event: dict[str, Any], line_index: int) -> list[FlowData]:
    out: list[FlowData] = []
    for block_index, block in enumerate(_content_blocks(event)):
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text = str(block.get("text") or "")
            if not text:
                continue
            entry = AssistantMessageEntry(
                text=text,
                **_base_for_event(event, line_index, block_index, str(block.get("id") or "")),
            )
            out.append(_with_process_entry(FlowData(
                flow_value=text,
                created_time=entry.timestamp,
                attributes={
                    "element-type": FlowElementType.CHAT,
                    "data-type": FlowDataType.TEXT,
                    "role": "assistant",
                },
            ), entry))
        elif btype == "thinking":
            thinking = str(block.get("thinking") or block.get("text") or "")
            if not thinking:
                continue
            entry = AssistantMessageEntry(
                text="",
                thinking=thinking,
                **_base_for_event(event, line_index, block_index, str(block.get("id") or "")),
            )
            out.append(_with_process_entry(FlowData(
                flow_value=thinking,
                created_time=entry.timestamp,
                attributes={
                    "element-type": FlowElementType.REASONING,
                    "data-type": FlowDataType.TEXT,
                    "role": "assistant",
                },
            ), entry))
        elif btype == "tool_use":
            tool_name = str(block.get("name") or "")
            tool_use_id = str(block.get("id") or "")
            tool_input = block.get("input") if isinstance(block.get("input"), dict) else {}
            # Route through the SAME semantic mapping the JSONL parser uses,
            # then the SAME converter the history path uses, so a live frame is
            # identical to the one a reload replays — including the semantic
            # subtype (file_write / skill_call / flow_command …) the chips read.
            entry = derive_entry(build_semantic_tool_entry(
                tool_name=tool_name,
                tool_use_id=tool_use_id,
                tool_input=tool_input,
                envelope={},
                base=_base_for_event(event, line_index, block_index, tool_use_id),
            ))
            out.append(entry_to_flowdata(entry, observation_kind="live"))
    return out


def _convert_user_event(event: dict[str, Any], line_index: int) -> list[FlowData]:
    out: list[FlowData] = []
    for block_index, block in enumerate(_content_blocks(event)):
        if not isinstance(block, dict):
            continue
        # Framework-injected user lines (skill bodies, command expansions)
        # arrive on the live stream as user text blocks mid-turn — the same
        # lines the transcript stamps ``isMeta``. Emit them so the live chat
        # renders the same meta chip a reload does. ``is_meta=True`` is by
        # construction, not read off the event: the live stream strips the
        # ``isMeta`` field, and a genuine user turn is never echoed on stdout
        # (verified against the real CLI with ``--input-format stream-json``),
        # so a stdout user text block is always a framework injection.
        if block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str) and text:
                entry = UserMessageEntry(
                    text=text,
                    is_meta=True,
                    **_base_for_event(event, line_index, block_index, ""),
                )
                # Delegate to the history path's converter so the live frame
                # is identical to the one a reload replays.
                out.append(entry_to_flowdata(entry, observation_kind="live"))
            continue
        if block.get("type") != "tool_result":
            continue
        tool_use_id = str(block.get("tool_use_id") or "")
        output = flatten_tool_result(block.get("content"))
        entry = ToolResultEntry(
            tool_use_id=tool_use_id,
            tool_output=output,
            is_error=bool(block.get("is_error", False)),
            **_base_for_event(event, line_index, block_index, tool_use_id),
        )
        out.append(_with_process_entry(FlowData(
            flow_value={
                "tool_call_id": tool_use_id,
                "tool_use_id": tool_use_id,
                "content": output,
                "output": output,
            },
            created_time=entry.timestamp,
            attributes={
                "element-type": FlowElementType.TOOL_RESULT,
                "data-type": FlowDataType.OBJECT,
                "tool-use-id": tool_use_id,
            },
        ), entry))
    return out


def _wrap_live(entry) -> FlowData:
    """Wrap one TranscriptEntry from the live stream in a FlowData envelope."""
    pe = ProcessEntry(transcript_entry=entry, observation_kind="live")
    return FlowData(
        flow_value={},  # canonical content lives on process_entry; flow_value kept for back-compat shape only
        created_time=entry.timestamp or "",
        attributes={
            "element-type": _element_type_for_kind(entry.kind.value),
            "data-type": FlowDataType.OBJECT,
        },
        process_entry=pe.to_dict(),
    )


_TOOL_USE_KINDS = frozenset({
    "tool_use", "shell_command", "file_write", "file_edit", "file_read",
    "search", "web_fetch", "todo_update", "agent_spawn", "exit_plan_mode",
})


def _element_type_for_kind(kind: str) -> str:
    """Map a TranscriptEntry kind to an existing FlowElementType so legacy
    consumers still see a meaningful element-type during the migration window."""
    if kind == "user_message":
        return FlowElementType.USER_MESSAGE
    if kind == "assistant_message":
        return FlowElementType.CHAT
    if kind in _TOOL_USE_KINDS:
        return FlowElementType.TOOL_CALL
    if kind == "tool_result":
        return FlowElementType.TOOL_RESULT
    return FlowElementType.STATUS


def _convert_result(event: dict[str, Any]) -> list[FlowData]:
    subtype = event.get("subtype") or "unknown"
    outcome = "success" if subtype == "success" else "error"
    attrs: dict[str, str] = {
        "element-type": FlowElementType.RESULT,
        "data-type": FlowDataType.OBJECT,
        "outcome": outcome,
        "subtype": str(subtype),
    }
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
