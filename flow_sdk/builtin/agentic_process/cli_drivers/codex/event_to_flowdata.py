"""Convert Codex CLI ``codex exec --json`` events into FlowData.

Stream events share the per-turn shape of Codex rollout JSONLs (the codex
parser auto-detects stream-vs-rollout). We delegate parsing to ``CodexParser``
and wrap each emitted ``TranscriptEntry`` in a
``ProcessEntry(observation_kind='live')`` rideing on ``FlowData.process_entry``.

Logger namespace: ``flow_sdk.builtin.agentic_process.cli_drivers.codex.event_to_flowdata``.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import wrap_live
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer.entry import EntryKind
from flow_sdk.transcript_analyzer.parsers.codex import CodexParser

logger = logging.getLogger(__name__)


_parser = CodexParser()
_line_index = 0


_TOOL_USE_KINDS = frozenset({
    "tool_use", "shell_command", "file_write", "file_edit", "file_read",
    "search", "web_fetch", "todo_update", "agent_spawn", "exit_plan_mode",
})


def convert_event(event: dict[str, Any]) -> list[FlowData]:
    """Map a single codex stream event to zero or more FlowData items.

    Conversational events become FlowData carrying a typed ``process_entry``.
    ``turn.completed`` ends the stream with a result frame + end frame.
    """
    global _line_index

    etype = event.get("type")

    if etype == "turn.completed":
        return _convert_turn_completed(event)
    try:
        entries = _parser.feed(event, _line_index)
    except Exception:
        logger.debug("codex_event_to_flowdata: parse failed", exc_info=True)
        return [_status("parse-error", _safe_dump(event))]
    finally:
        _line_index += 1

    if etype == "error" and not any(
        e.kind is EntryKind.WORKER_UNAVAILABLE for e in entries
    ):
        # A provider quota/rate-limit error is not a crash: the parser
        # normalizes it into the vendor-blind WORKER_UNAVAILABLE frame (same
        # shape Claude emits) so callers can tell "the account is out" from
        # "the CLI broke". Anything else stays a raw ERROR frame.
        return [_error(_safe_dump(event))]

    if not entries:
        # Non-conversational lines (thread.started, turn.started, item.started
        # for partial-stream items) — surface a small status so the wire stream
        # stays continuous but no process_entry is emitted.
        return [_status(str(etype) or "unknown", _safe_dump(event))]

    return [_wrap_live(e) for e in entries]


def convert_line(line: str) -> list[FlowData]:
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
    return FlowData(
        flow_value="",
        attributes={
            "element-type": FlowElementType.END,
            "data-type": FlowDataType.TEXT,
        },
    )


# ── Internals ─────────────────────────────────────────────────────────────────


def _wrap_live(entry) -> FlowData:
    """This vendor's element-type mapping over the shared live envelope."""
    return wrap_live(entry, _element_type_for_kind)

def _element_type_for_kind(kind: str) -> str:
    if kind == "user_message":
        return FlowElementType.USER_MESSAGE
    if kind == "assistant_message":
        return FlowElementType.CHAT
    if kind in _TOOL_USE_KINDS:
        return FlowElementType.TOOL_CALL
    if kind == "tool_result":
        return FlowElementType.TOOL_RESULT
    return FlowElementType.STATUS


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
