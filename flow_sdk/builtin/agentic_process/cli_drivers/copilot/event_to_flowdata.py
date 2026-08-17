"""Convert Copilot CLI JSON events into FlowData."""

from __future__ import annotations

import json
import logging
from typing import Any

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer.derive import derive_entry
from flow_sdk.transcript_analyzer.entries import AssistantMessageEntry
from flow_sdk.transcript_analyzer.parsers.copilot import CopilotParser
from flow_sdk.transcript_analyzer.process_entry import ProcessEntry

logger = logging.getLogger(__name__)


class CopilotEventConverter:
    """Stateful converter for one live Copilot stream."""

    def __init__(self) -> None:
        self._parser = CopilotParser()
        self._line_index = 0
        self._message_ids_with_deltas: set[str] = set()
        self._reasoning_ids_with_deltas: set[str] = set()

    def convert_event(self, event: dict[str, Any]) -> list[FlowData]:
        event_type = event.get("type")
        flowpad_terminal = flowpad_terminal_event_frames(event)
        if flowpad_terminal is not None:
            return flowpad_terminal
        if event_type == "result":
            self._capture_session(event)
            return _result(event)
        if event_type == "assistant.message_delta":
            return self._message_delta(event)
        if event_type == "assistant.reasoning_delta":
            return self._reasoning_delta(event)

        try:
            entries = self._parser.feed(event, self._line_index)
        except Exception:
            logger.debug("copilot_event_to_flowdata: parse failed", exc_info=True)
            return [_status("parse-error", _safe_dump(event))]
        finally:
            self._line_index += 1

        out: list[FlowData] = []
        for entry in entries:
            if isinstance(entry, AssistantMessageEntry):
                if entry.text and entry.entry_id in self._message_ids_with_deltas:
                    continue
                if entry.thinking and entry.entry_id in self._reasoning_ids_with_deltas:
                    continue
            out.append(_wrap_live(entry))
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
            logger.debug("copilot_event_to_flowdata: non-JSON line: %r", line[:200])
            return []
        if not isinstance(event, dict):
            return []
        return self.convert_event(event)

    def _message_delta(self, event: dict[str, Any]) -> list[FlowData]:
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        message_id = str(data.get("messageId") or event.get("id") or "")
        delta = str(data.get("deltaContent") or "")
        if not delta:
            return [_status("assistant.message_delta", _safe_dump(event))]
        if message_id:
            self._message_ids_with_deltas.add(message_id)
        entry = AssistantMessageEntry(
            id=str(event.get("id") or message_id or "copilot-delta"),
            session_id=self._parser.session_id,
            timestamp=str(event.get("timestamp") or ""),
            worker="copilot",
            parent_id=event.get("parentId"),
            entry_id=message_id or None,
            model=self._parser._current_model,  # intentionally same parser state as final events
            text=delta,
        )
        return [_wrap_live(entry)]

    def _reasoning_delta(self, event: dict[str, Any]) -> list[FlowData]:
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        reasoning_id = str(data.get("reasoningId") or event.get("id") or "")
        delta = str(data.get("deltaContent") or "")
        if not delta:
            return [_status("assistant.reasoning_delta", _safe_dump(event))]
        if reasoning_id:
            self._reasoning_ids_with_deltas.add(reasoning_id)
        entry = AssistantMessageEntry(
            id=str(event.get("id") or reasoning_id or "copilot-reasoning"),
            session_id=self._parser.session_id,
            timestamp=str(event.get("timestamp") or ""),
            worker="copilot",
            parent_id=event.get("parentId"),
            entry_id=reasoning_id or None,
            model=self._parser._current_model,
            text="",
            thinking=delta,
        )
        return [_wrap_live(entry)]

    def _capture_session(self, event: dict[str, Any]) -> None:
        sid = event.get("sessionId")
        if sid and not self._parser.session_id:
            self._parser.session_id = str(sid)


_default_converter = CopilotEventConverter()


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


def flowpad_terminal_event_frames(event: dict[str, Any]) -> list[FlowData] | None:
    """Convert a Flowpad-authored Copilot terminal marker for live or replay."""
    event_type = event.get("type")
    if event_type == "flowpad.interrupted":
        from flow_sdk.builtin.agentic_process.turn_abort import (
            abort_status_frame,  # noqa: PLC0415 — avoid import cycle at module load
        )

        # User-requested cancel is not an error: emit the canonical turn-abort
        # STATUS so in-flight tool calls terminate instead of painting a crash.
        return [abort_status_frame(), final_end_frame()]
    if event_type == "flowpad.error":
        message = str(event.get("message") or "copilot exited with an error")
        return [_error(message), final_end_frame()]
    return None


def _wrap_live(entry) -> FlowData:
    # Derived refinements (e.g. a `flow` CLI call inside a shell command)
    # are applied here so the live frame matches what history's refold
    # produces for the same entry.
    entry = derive_entry(entry)
    process_entry = ProcessEntry(transcript_entry=entry, observation_kind="live")
    frames = entry.to_flow_data()
    if frames:
        fd = frames[0]
        fd.process_entry = process_entry.to_dict()
        fd.attributes.setdefault("element-type", _element_type_for_kind(entry.kind.value))
        fd.attributes.setdefault("data-type", FlowDataType.OBJECT)
        fd.attributes.setdefault("subtype", entry.kind.value)
        fd.attributes.setdefault("observation-kind", "live")
        return fd
    return FlowData(
        flow_value={},
        created_time=entry.timestamp or "",
        attributes={
            "element-type": _element_type_for_kind(entry.kind.value),
            "data-type": FlowDataType.OBJECT,
            "subtype": entry.kind.value,
            "observation-kind": "live",
        },
        process_entry=process_entry.to_dict(),
    )


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
    attrs = {
        "element-type": FlowElementType.RESULT,
        "data-type": FlowDataType.OBJECT,
        "outcome": outcome,
        "subtype": "result",
    }
    return [
        FlowData(
            flow_value={
                "session_id": event.get("sessionId"),
                "exit_code": exit_code,
                "usage": event.get("usage") or {},
            },
            created_time=str(event.get("timestamp") or ""),
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
