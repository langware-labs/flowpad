"""Unit tests for claude_event_to_flowdata — the stream-json event → FlowData
converter used by the print-mode AgenticProcess path.

Fixture events mirror the shapes emitted by Claude CLI 2.1.116 in
``--output-format stream-json`` mode; captured empirically by
``scripts/verify_stream_json.py``.
"""

from __future__ import annotations

from flow_sdk.builtin.agentic_process.cli_drivers.claude import (
    convert_event,
    convert_line,
    final_end_frame,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowDataType,
    FlowElementType,
)


# ── system:* events ───────────────────────────────────────────────────────────


def test_system_init_becomes_status_with_subtype():
    out = convert_event({"type": "system", "subtype": "init"})
    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.STATUS
    assert out[0].attributes["subtype"] == "init"


def test_system_hook_started_becomes_status():
    out = convert_event({"type": "system", "subtype": "hook_started", "hook_name": "PostToolUse"})
    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.STATUS
    assert out[0].attributes["subtype"] == "hook_started"


def test_system_without_subtype_falls_back_to_system():
    out = convert_event({"type": "system"})
    assert out[0].attributes["subtype"] == "system"


# ── assistant blocks ─────────────────────────────────────────────────────────


def test_assistant_text_block_becomes_chat():
    out = convert_event({
        "type": "assistant",
        "message": {"content": [{"type": "text", "text": "hello"}]},
    })
    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.CHAT
    assert out[0].attributes["role"] == "assistant"
    assert out[0].flow_value == "hello"


def test_assistant_thinking_block_becomes_reasoning():
    out = convert_event({
        "type": "assistant",
        "message": {"content": [{"type": "thinking", "thinking": "hmm"}]},
    })
    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.REASONING
    assert out[0].flow_value == "hmm"


def test_assistant_tool_use_block_becomes_tool_call():
    out = convert_event({
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_abc",
                    "name": "Bash",
                    "input": {"command": "ls -1"},
                }
            ]
        },
    })
    assert len(out) == 1
    fd = out[0]
    assert fd.attributes["element-type"] == FlowElementType.TOOL_CALL
    assert fd.attributes["tool-name"] == "Bash"
    assert fd.attributes["data-type"] == FlowDataType.OBJECT
    assert fd.flow_value["tool_name"] == "Bash"
    assert fd.flow_value["tool_call_id"] == "toolu_abc"
    assert fd.flow_value["args"] == {"command": "ls -1"}


def test_assistant_with_multiple_blocks_yields_multiple_flowdata():
    out = convert_event({
        "type": "assistant",
        "message": {
            "content": [
                {"type": "text", "text": "ok"},
                {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}},
            ]
        },
    })
    assert len(out) == 2
    assert out[0].attributes["element-type"] == FlowElementType.CHAT
    assert out[1].attributes["element-type"] == FlowElementType.TOOL_CALL


def test_assistant_empty_text_is_skipped():
    out = convert_event({"type": "assistant", "message": {"content": [{"type": "text", "text": ""}]}})
    assert out == []


def test_assistant_unknown_block_type_is_ignored():
    out = convert_event({
        "type": "assistant",
        "message": {"content": [{"type": "some-future-thing", "data": 1}]},
    })
    assert out == []


# ── user / tool_result ────────────────────────────────────────────────────────


def test_user_tool_result_becomes_tool_result_flowdata():
    out = convert_event({
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_abc",
                    "content": [{"type": "text", "text": "stdout…"}],
                }
            ]
        },
    })
    assert len(out) == 1
    fd = out[0]
    assert fd.attributes["element-type"] == FlowElementType.TOOL_RESULT
    assert fd.attributes["tool-use-id"] == "toolu_abc"
    assert fd.flow_value["tool_call_id"] == "toolu_abc"


def test_user_without_tool_result_yields_nothing():
    out = convert_event({"type": "user", "message": {"content": [{"type": "text", "text": "hi"}]}})
    assert out == []


# ── rate_limit_event ──────────────────────────────────────────────────────────


def test_rate_limit_event_becomes_status():
    out = convert_event({"type": "rate_limit_event", "retry_after": 10})
    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.STATUS
    assert out[0].attributes["subtype"] == "rate-limit"


# ── result:* → RESULT + END ───────────────────────────────────────────────────


def test_result_success_yields_result_then_end():
    out = convert_event({
        "type": "result",
        "subtype": "success",
        "total_cost_usd": 0.21,
        "duration_ms": 12000,
    })
    assert len(out) == 2
    result_fd, end_fd = out
    assert result_fd.attributes["element-type"] == FlowElementType.RESULT
    assert result_fd.attributes["outcome"] == "success"
    assert result_fd.attributes["cost-usd"] == "0.21"
    assert end_fd.attributes["element-type"] == FlowElementType.END


def test_result_error_yields_error_outcome():
    out = convert_event({"type": "result", "subtype": "error_max_turns"})
    assert len(out) == 2
    assert out[0].attributes["outcome"] == "error"
    assert out[0].attributes["subtype"] == "error_max_turns"
    assert out[1].attributes["element-type"] == FlowElementType.END


# ── unknown events — defensive fallback ───────────────────────────────────────


def test_unknown_event_type_yields_unknown_status_never_raises():
    out = convert_event({"type": "something_new", "payload": {"nested": True}})
    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.STATUS
    assert out[0].attributes["subtype"] == "unknown"


def test_empty_event_yields_unknown_status():
    out = convert_event({})
    assert len(out) == 1
    assert out[0].attributes["subtype"] == "unknown"


# ── convert_line — JSON parsing shell ─────────────────────────────────────────


def test_convert_line_parses_json_and_dispatches():
    out = convert_line('{"type": "system", "subtype": "init"}')
    assert len(out) == 1
    assert out[0].attributes["element-type"] == FlowElementType.STATUS


def test_convert_line_swallows_invalid_json():
    assert convert_line("not-json") == []
    assert convert_line("") == []
    assert convert_line("  \n") == []


def test_convert_line_swallows_non_object_json():
    assert convert_line("[1, 2, 3]") == []
    assert convert_line('"just a string"') == []


# ── final_end_frame ──────────────────────────────────────────────────────────


def test_final_end_frame_is_an_end_flowdata():
    fd = final_end_frame()
    assert fd.attributes["element-type"] == FlowElementType.END
    assert fd.attributes["data-type"] == FlowDataType.TEXT
