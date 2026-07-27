"""Unit tests for claude_event_to_flowdata — the stream-json event → FlowData
converter used by the print-mode AgenticProcess path.

Fixture events mirror the shapes emitted by Claude CLI 2.1.116 in
``--output-format stream-json`` mode; captured empirically by
``scripts/verify_stream_json.py``.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude import (
    convert_event,
    convert_line,
    final_end_frame,
)
from flow_sdk.builtin.agentic_process.cli_drivers.claude.session_history import (
    entry_to_flowdata,
)
from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer.derive import derive_entry
from flow_sdk.transcript_analyzer.parsers.claude import (
    ClaudeParser,
    build_semantic_tool_entry,
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


def test_weekly_limit_live_flowdata_matches_replay_shape():
    event = {
        "type": "assistant",
        "error": "rate_limit",
        "isApiErrorMessage": True,
        "apiErrorStatus": 429,
        "uuid": "quota-event",
        "sessionId": "quota-session",
        "timestamp": "2026-07-27T10:00:00Z",
        "message": {
            "model": "<synthetic>",
            "stop_reason": "stop_sequence",
            "content": [{
                "type": "text",
                "text": "You've hit your weekly limit · resets 3pm (Asia/Jerusalem)",
            }],
        },
    }

    live = convert_event(event)[0]
    entry = ClaudeParser().feed(event, 0)[0]
    replay = entry_to_flowdata(entry, observation_kind="replay")

    assert live.attributes["element-type"] == FlowElementType.WORKER_UNAVAILABLE
    assert live.attributes["subtype"] == "worker_unavailable"
    assert live.flow_value == replay.flow_value
    assert live.process_entry["transcript_entry"] == replay.process_entry["transcript_entry"]
    assert live.flow_value["recoverable_with_alternative"] is True
    assert "<flow-worker-unavailable " in live.to_xml
    assert 'worker-type="claude_code"' in live.to_xml
    assert 'status-code="429"' in live.to_xml


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


def test_user_text_block_yields_meta_user_message():
    # Framework-injected user lines (skill bodies, command expansions) arrive
    # on the live stream as user text blocks — they must surface as is-meta
    # USER_MESSAGE frames so the "Using skill" chip renders live, not only
    # after a refresh replays the transcript.
    out = convert_event({"type": "user", "message": {"content": [{"type": "text", "text": "hi"}]}})
    assert len(out) == 1
    fd = out[0]
    assert fd.attributes["element-type"] == FlowElementType.USER_MESSAGE
    assert fd.attributes["is-meta"] == "true"
    assert fd.flow_value == "hi"


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


# ── semantic tool_use: live must equal history ───────────────────────────────
#
# The live converter used to hand-build a generic TOOL_CALL FlowData for every
# tool_use block, so a live `Skill` had no skill-name and a live `Write` no
# `file_write` subtype — while the SAME block rendered semantically after a
# reload. Both paths now route through `build_semantic_tool_entry` +
# `entry_to_flowdata`; these tests are the guard against that drifting apart.

_FLOW_TYPE_ID = "skill-3f2a1b4c-0000-4000-8000-000000000001"

_TOOL_BLOCKS = [
    ("Write", {"file_path": "/tmp/a.txt", "content": "hi"}, "file_write"),
    ("Read", {"file_path": "/tmp/a.txt"}, "file_read"),
    ("Edit", {"file_path": "/tmp/a.txt", "old_string": "a", "new_string": "b"}, "file_edit"),
    ("Skill", {"skill": "rca"}, "skill_call"),
    ("Bash", {"command": "ls -la"}, "shell_command"),
    ("Bash", {"command": f"flow show entity {_FLOW_TYPE_ID}"}, "flow_command"),
    ("Glob", {"pattern": "*.py"}, "search"),
    ("mcp__thing__do", {"whatever": 1}, "tool_use"),
]


def _live(tool_name: str, tool_input: dict):
    out = convert_event({
        "type": "assistant",
        "uuid": "a1",
        "sessionId": "s1",
        "timestamp": "2026-07-23T10:00:00Z",
        "message": {
            "id": "msg_1",
            "role": "assistant",
            "content": [{"type": "tool_use", "id": "toolu_1", "name": tool_name, "input": tool_input}],
        },
    })
    assert len(out) == 1
    return out[0]


def _history(tool_name: str, tool_input: dict):
    entry = derive_entry(build_semantic_tool_entry(
        tool_name=tool_name,
        tool_use_id="toolu_1",
        tool_input=tool_input,
        envelope={},
        base={
            "id": "a1",
            "session_id": "s1",
            "timestamp": "2026-07-23T10:00:00Z",
            "worker": "claude",
            "parent_id": None,
            "is_sidechain": False,
        },
    ))
    return entry_to_flowdata(entry, observation_kind="replay")


@pytest.mark.parametrize(("tool_name", "tool_input", "subtype"), _TOOL_BLOCKS)
def test_live_tool_use_carries_the_semantic_subtype(tool_name, tool_input, subtype):
    fd = _live(tool_name, tool_input)
    assert fd.attributes["element-type"] == FlowElementType.TOOL_CALL
    assert fd.attributes["subtype"] == subtype
    assert fd.attributes["observation-kind"] == "live"
    assert fd.attributes["tool-name"] == tool_name


@pytest.mark.parametrize(("tool_name", "tool_input", "subtype"), _TOOL_BLOCKS)
def test_live_frame_matches_the_replayed_frame(tool_name, tool_input, subtype):
    live = _live(tool_name, tool_input)
    replay = _history(tool_name, tool_input)

    live_attrs = {k: v for k, v in live.attributes.items() if k != "observation-kind"}
    replay_attrs = {k: v for k, v in replay.attributes.items() if k != "observation-kind"}
    assert live_attrs == replay_attrs
    assert live.flow_value == replay.flow_value


def test_live_skill_call_names_the_skill():
    fd = _live("Skill", {"skill": "rca"})
    assert fd.attributes["skill-name"] == "rca"


def test_live_flow_command_carries_verb_and_target():
    fd = _live("Bash", {"command": f"flow show entity {_FLOW_TYPE_ID}"})
    assert fd.attributes["flow-verb"] == "show"
    assert fd.attributes["flow-subverb"] == "entity"
    assert fd.attributes["flow-target"] == _FLOW_TYPE_ID


def test_live_file_op_keeps_the_path_in_args():
    fd = _live("Write", {"file_path": "/tmp/a.txt", "content": "hi"})
    assert fd.flow_value["args"]["file_path"] == "/tmp/a.txt"


def test_live_tool_use_carries_a_typed_process_entry():
    fd = _live("Read", {"file_path": "/tmp/a.txt"})
    assert fd.process_entry["transcript_entry"]["kind"] == "file_read"
    assert fd.process_entry["transcript_entry"]["path"] == "/tmp/a.txt"
