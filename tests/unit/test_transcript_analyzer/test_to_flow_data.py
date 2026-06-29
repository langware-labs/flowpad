"""``TranscriptEntry.to_flow_data()`` polymorphism + timestamp propagation."""

from __future__ import annotations

import warnings

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)
from flow_sdk.transcript_analyzer import (
    AgentTranscriptFile,
    AssistantMessageEntry,
    MetaEntry,
    ShellCommandEntry,
    SummaryEntry,
    SystemEntry,
    ToolUseEntry,
    UnknownEntry,
    UserMessageEntry,
)


def _flatten(t: AgentTranscriptFile) -> list[FlowData]:
    return [fd for e in t.entries for fd in e.to_flow_data()]


def test_user_message_emits_user_message_flow_data(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    user_entry = next(e for e in t.entries if isinstance(e, UserMessageEntry))
    fds = user_entry.to_flow_data()
    assert len(fds) == 1
    assert fds[0].attributes["element-type"] == FlowElementType.USER_MESSAGE
    assert fds[0].attributes["data-type"] == FlowDataType.TEXT
    assert fds[0].attributes["role"] == "user"
    assert fds[0].flow_value == user_entry.text
    assert fds[0].created_time == user_entry.timestamp


def test_assistant_message_emits_chat_flow_data(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    am = next(e for e in t.entries if isinstance(e, AssistantMessageEntry))
    fds = am.to_flow_data()
    # Sanitized fixture has thinking + text → two FlowData, REASONING then CHAT.
    types = [fd.attributes["element-type"] for fd in fds]
    assert FlowElementType.CHAT in types
    assert FlowElementType.REASONING in types
    chat = next(fd for fd in fds if fd.attributes["element-type"] == FlowElementType.CHAT)
    assert chat.attributes["role"] == "assistant"


def test_tool_use_emits_tool_call_flow_data(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    bash = next(e for e in t.entries if isinstance(e, ToolUseEntry) and e.tool_name == "Bash")
    fds = bash.to_flow_data()
    assert len(fds) == 1
    assert fds[0].attributes["element-type"] == FlowElementType.TOOL_CALL
    assert fds[0].attributes["tool-name"] == "Bash"


def test_folded_shell_command_emits_tool_call_flow_data(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    r = next(e for e in t.entries if isinstance(e, ShellCommandEntry))
    fds = r.to_flow_data()
    assert len(fds) == 1
    assert fds[0].attributes["element-type"] == FlowElementType.TOOL_CALL
    assert fds[0].attributes["tool-name"] == "Bash"
    assert "ok" in (fds[0].flow_value.get("stdout") or "")


def test_system_entry_emits_no_flow_data(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    sys_entry = next(e for e in t.entries if isinstance(e, SystemEntry))
    assert sys_entry.to_flow_data() == []


def test_meta_entry_emits_no_flow_data(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    metas = [e for e in t.entries if isinstance(e, MetaEntry)]
    assert metas
    for m in metas:
        assert m.to_flow_data() == []


def test_unknown_entry_emits_no_flow_data(claude_jsonl):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t = AgentTranscriptFile("claude", claude_jsonl)
    unknowns = [e for e in t.entries if isinstance(e, UnknownEntry)]
    assert unknowns
    for u in unknowns:
        assert u.to_flow_data() == []


def test_transcript_to_flow_data_concatenates_per_entry(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    direct = _flatten(t)
    via_method = t.to_flow_data()
    assert len(direct) == len(via_method)


def test_codex_command_execution_emits_paired_flow_data(codex_stream_jsonl):
    t = AgentTranscriptFile("codex", codex_stream_jsonl)
    fd = t.to_flow_data()
    # We expect at least one TOOL_CALL and one TOOL_RESULT for the
    # synthesized shell pair.
    element_types = [f.attributes["element-type"] for f in fd]
    assert FlowElementType.TOOL_CALL in element_types
    assert FlowElementType.TOOL_RESULT in element_types


def test_created_time_propagated_from_line_timestamp(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    for e in t.entries:
        for fd in e.to_flow_data():
            assert fd.created_time == e.timestamp
