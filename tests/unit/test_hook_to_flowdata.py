"""Unit tests for the Claude hook → generic FlowData translator.

The translator lives in
``flow_sdk.builtin.agentic_process.cli_drivers.claude.hook_to_flowdata`` and
is the *only* place sniffer events are converted to a vendor-agnostic
``FlowData`` shape. The InteractiveTerminal trace gutter consumes the result
without ever importing a Claude-hook-specific module.
"""

from __future__ import annotations

from flow_sdk.builtin.agentic_process.cli_drivers.claude.hook_to_flowdata import (
    convert_hook_event,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowDataSource,
    FlowDataType,
    FlowElementType,
)


def _pre_tool_use_payload() -> dict:
    """Minimal payload mirroring what listen.handle_agent_hook builds."""
    return {
        "webhook_type": "agent_hook",
        "agent_hook_id": "hook-abc",
        "hook_entry_id": "trigger-xyz",
        "hook_data": {
            "hook_event_name": "PreToolUse",
            "session_id": "session-123",
            "tool_name": "Read",
            "tool_use_id": "toolu_01",
            "transcript_path": "/Users/x/.claude/projects/proj/session-123.jsonl",
            "raw_hook_data": {
                "session_id": "session-123",
                "tool_input": {"file_path": "/etc/passwd"},
            },
        },
        "hook_metadata": {},
        "hook_file_path": "/some/hook/file.sh",
    }


def test_convert_hook_event_emits_status_with_sniffer_source() -> None:
    payload = _pre_tool_use_payload()
    out = convert_hook_event(payload)
    assert len(out) == 1
    fd = out[0]
    assert fd.element_type == FlowElementType.STATUS
    assert fd.attributes["source"] == FlowDataSource.SNIFFER
    assert fd.attributes["data-type"] == FlowDataType.OBJECT


def test_convert_hook_event_carries_subtype_tool_and_ids() -> None:
    payload = _pre_tool_use_payload()
    fd = convert_hook_event(payload)[0]
    assert fd.attributes["subtype"] == "PreToolUse"
    assert fd.attributes["tool-name"] == "Read"
    assert fd.attributes["tool-use-id"] == "toolu_01"
    assert fd.attributes["webhook-type"] == "agent_hook"
    assert fd.attributes["agent-hook-id"] == "hook-abc"
    assert fd.attributes["hook-entry-id"] == "trigger-xyz"
    assert fd.attributes["transcript-path"].endswith("session-123.jsonl")


def test_convert_hook_event_post_tool_use_minimal() -> None:
    payload = {
        "webhook_type": "agent_hook",
        "agent_hook_id": "h",
        "hook_data": {"hook_event_name": "PostToolUse", "session_id": "s"},
    }
    fd = convert_hook_event(payload)[0]
    assert fd.attributes["subtype"] == "PostToolUse"
    assert "tool-name" not in fd.attributes
    assert "tool-use-id" not in fd.attributes


def test_convert_hook_event_session_start_no_tool() -> None:
    payload = {
        "webhook_type": "agent_hook",
        "agent_hook_id": "h",
        "hook_data": {
            "hook_event_name": "SessionStart",
            "raw_hook_data": {"session_id": "fresh-session"},
        },
    }
    fd = convert_hook_event(payload)[0]
    assert fd.attributes["subtype"] == "SessionStart"
    # session_id lookup happens in listen.py, not here. The translator only
    # carries hook fields; it does not need session_id on the FlowData.
    assert "tool-name" not in fd.attributes


def test_convert_hook_event_returns_empty_for_invalid_payload() -> None:
    assert convert_hook_event(None) == []  # type: ignore[arg-type]
    assert convert_hook_event("not a dict") == []  # type: ignore[arg-type]
    # Empty dict still produces a single defensive STATUS item with no
    # discriminating attrs — that's fine; downstream filters it out.
    out = convert_hook_event({})
    assert len(out) == 1
    fd = out[0]
    assert fd.element_type == FlowElementType.STATUS
    assert fd.attributes["source"] == FlowDataSource.SNIFFER


def test_field_extractors_session_id_from_dict() -> None:
    from flow_sdk.claude_hook_events.field_extractors import extract_session_id_from_dict

    assert extract_session_id_from_dict(None) is None  # type: ignore[arg-type]
    assert extract_session_id_from_dict({}) is None
    assert extract_session_id_from_dict({"session_id": "s1"}) == "s1"
    assert (
        extract_session_id_from_dict({"raw_hook_data": {"session_id": "raw-s1"}}) == "raw-s1"
    )
    # raw_hook_data wins over top-level
    assert (
        extract_session_id_from_dict(
            {"session_id": "top", "raw_hook_data": {"session_id": "raw"}}
        )
        == "raw"
    )
    assert (
        extract_session_id_from_dict({"event": {"context": {"session_id": "ctx-s"}}})
        == "ctx-s"
    )
