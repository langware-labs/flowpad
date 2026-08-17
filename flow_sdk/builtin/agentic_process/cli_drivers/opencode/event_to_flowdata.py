"""Convert OpenCode CLI JSON events into FlowData.

Simpler than the copilot converter: opencode emits whole ``text`` events rather
than incremental deltas, so there is no delta/final dedup state to carry.
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
from flow_sdk.transcript_analyzer.parsers.opencode import OpenCodeParser

logger = logging.getLogger(__name__)


class OpenCodeEventConverter:
    """Stateful converter for one live OpenCode stream."""

    def __init__(self) -> None:
        self._parser = OpenCodeParser()
        self._line_index = 0

    def convert_event(self, event: dict[str, Any]) -> list[FlowData]:
        event_type = event.get("type")

        if event_type == "flowpad.result":
            return _result(event)
        if event_type == "flowpad.interrupted":
            # A user-requested cancel is not an error: emit the canonical
            # turn-abort STATUS so the chat marks the in-flight tool calls
            # terminated instead of painting a crash.
            from flow_sdk.builtin.agentic_process.turn_abort import abort_status_frame  # noqa: PLC0415 — avoid import cycle at module load

            return [abort_status_frame(), final_end_frame()]
        if event_type == "flowpad.error":
            message = str(event.get("message") or "opencode exited with an error")
            return [_error(message), final_end_frame()]

        try:
            entries = self._parser.feed(event, self._line_index)
        except Exception:
            logger.debug("opencode_event_to_flowdata: parse failed", exc_info=True)
            return [_status("parse-error", _safe_dump(event))]
        finally:
            self._line_index += 1

        out = [_wrap_live(entry) for entry in entries]
        if not out:
            return [_status(str(event_type) or "unknown", _safe_dump(event))]
        return out

    def convert_line(self, line: str) -> list[FlowData]:
        line = line.strip()
        if not line:
            return []
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            logger.debug("opencode_event_to_flowdata: non-JSON line: %r", line[:200])
            return []
        if not isinstance(event, dict):
            return []
        return self.convert_event(event)

    @property
    def session_id(self) -> str:
        return self._parser.session_id


_default_converter = OpenCodeEventConverter()


def convert_event(event: dict[str, Any]) -> list[FlowData]:
    return _default_converter.convert_event(event)


def convert_line(line: str) -> list[FlowData]:
    return _default_converter.convert_line(line)


def final_end_frame() -> FlowData:
    return FlowData(
        flow_value="",
        attributes={
            "element-type": FlowElementType.END,
            "data-type": FlowDataType.TEXT,
        },
    )


def _wrap_live(entry) -> FlowData:
    """This vendor's element-type mapping over the shared live envelope."""
    return wrap_live(entry, _element_type_for_kind)

def _element_type_for_kind(kind: str) -> str:
    if kind == "user_message":
        return FlowElementType.USER_MESSAGE
    if kind == "assistant_message":
        return FlowElementType.CHAT
    if kind == "tool_use":
        return FlowElementType.TOOL_CALL
    if kind == "tool_result":
        return FlowElementType.TOOL_RESULT
    return FlowElementType.STATUS


def _result(event: dict[str, Any]) -> list[FlowData]:
    exit_code = event.get("exitCode")
    outcome = "success" if exit_code in (0, None) else "error"
    return [
        FlowData(
            flow_value={
                "session_id": event.get("sessionID"),
                "exit_code": exit_code,
                "usage": event.get("usage") or {},
            },
            created_time=str(event.get("timestamp") or ""),
            attributes={
                "element-type": FlowElementType.RESULT,
                "data-type": FlowDataType.OBJECT,
                "outcome": outcome,
                "subtype": "result",
            },
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


def _error(message: str) -> FlowData:
    return FlowData(
        flow_value=message,
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
