"""Convert the Deep Agents runner's JSON events into FlowData.

The runner emits one whole block per AI message (no deltas), so — like opencode — there is no
delta/final dedup state to carry. Conversion goes through the transcript parser, so a live frame
and the same line replayed from the transcript cannot disagree.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from flow_sdk.builtin.agentic_process.cli_drivers.replay_envelope import (
    error_frame,
    final_end_frame,
    safe_dump,
    status_frame,
    wrap_live,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer.parsers.deepagents import DeepAgentsParser

logger = logging.getLogger(__name__)


class DeepAgentsEventConverter:
    """Stateful converter for one live runner stream."""

    def __init__(self) -> None:
        self._parser = DeepAgentsParser()
        self._line_index = 0

    def convert_event(self, event: dict[str, Any]) -> list[FlowData]:
        event_type = event.get("type")

        if event_type == "result":
            return _result(event)
        if event_type == "flowpad.interrupted":
            # A user-requested cancel is not an error: emit the canonical turn-abort STATUS so
            # the chat marks the in-flight tool calls terminated instead of painting a crash.
            from flow_sdk.builtin.agentic_process.turn_abort import (
                abort_status_frame,  # noqa: PLC0415 — avoid import cycle at module load
            )

            return [abort_status_frame(), final_end_frame()]
        if event_type == "flowpad.error":
            message = str(event.get("message") or "deepagents exited with an error")
            return [error_frame(message), final_end_frame()]
        if event_type == "error":
            # Non-terminal: the runner always follows it with a ``result``.
            return [error_frame(str(event.get("message") or "deepagents turn failed"))]

        try:
            entries = self._parser.feed(event, self._line_index)
        except Exception:
            logger.debug("deepagents_event_to_flowdata: parse failed", exc_info=True)
            return [status_frame("parse-error", safe_dump(event))]
        finally:
            self._line_index += 1

        out = [wrap_live(entry, _element_type_for_kind) for entry in entries]
        if not out:
            return [status_frame(str(event_type) or "unknown", safe_dump(event))]
        return out

    def convert_line(self, line: str) -> list[FlowData]:
        line = line.strip()
        if not line:
            return []
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            logger.debug("deepagents_event_to_flowdata: non-JSON line: %r", line[:200])
            return []
        if not isinstance(event, dict):
            return []
        return self.convert_event(event)

    @property
    def session_id(self) -> str:
        return self._parser.session_id


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
    is_error = bool(event.get("is_error"))
    return [
        FlowData(
            flow_value={
                "session_id": event.get("session_id"),
                "exit_code": 1 if is_error else 0,
                "usage": event.get("usage") or {},
                "num_turns": event.get("num_turns"),
                "duration_ms": event.get("duration_ms"),
            },
            created_time=str(event.get("timestamp") or ""),
            attributes={
                "element-type": FlowElementType.RESULT,
                "data-type": FlowDataType.OBJECT,
                "outcome": "error" if is_error else "success",
                "subtype": "result",
            },
        ),
        final_end_frame(),
    ]
