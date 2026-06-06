"""Copilot parser coverage for stdout JSON stream fixtures."""

from __future__ import annotations

import warnings

from flow_sdk.transcript_analyzer import (
    AgentTranscriptFile,
    AssistantMessageEntry,
    EntryKind,
    MetaEntry,
    ToolResultEntry,
    ToolUseEntry,
    UserMessageEntry,
)
from flow_sdk.transcript_analyzer import TranscriptFormat
from flow_sdk.transcript_analyzer.entries import UnknownEntry


def test_stream_session_id_from_result(copilot_stream_jsonl):
    transcript = AgentTranscriptFile("copilot", copilot_stream_jsonl)

    assert transcript.session_id == "d816f984-5b1f-4785-83a1-8e4589530637"


def test_stream_parser_can_be_selected_by_format(copilot_stream_jsonl):
    transcript = AgentTranscriptFile(
        "copilot",
        copilot_stream_jsonl,
        transcript_format=TranscriptFormat.COPILOT_STREAM,
    )

    assert transcript.session_id == "d816f984-5b1f-4785-83a1-8e4589530637"
    assert [p.text for p in transcript.prompts] == ["Say stdin-ok in one sentence.\n"]


def test_stream_no_unknown_entries(copilot_stream_jsonl):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        transcript = AgentTranscriptFile("copilot", copilot_stream_jsonl)

    assert not any(isinstance(e, UnknownEntry) for e in transcript.entries)
    assert not any("unknown entry type" in str(w.message) for w in caught)


def test_stream_user_and_assistant_message(copilot_stream_jsonl):
    transcript = AgentTranscriptFile("copilot", copilot_stream_jsonl)
    users = [e for e in transcript.entries if isinstance(e, UserMessageEntry)]
    assistants = [e for e in transcript.entries if isinstance(e, AssistantMessageEntry)]

    assert users[0].text == "Say stdin-ok in one sentence.\n"
    assert any(e.text == "stdin-ok." for e in assistants)
    assert any(e.thinking and "straightforward request" in e.thinking for e in assistants)


def test_tool_failure_is_tool_result_not_worker_failure(copilot_tool_failure_jsonl):
    transcript = AgentTranscriptFile("copilot", copilot_tool_failure_jsonl)
    uses = [e for e in transcript.entries if isinstance(e, ToolUseEntry)]
    results = [e for e in transcript.entries if isinstance(e, ToolResultEntry)]

    assert any(e.tool_name == "bash" and e.tool_input["command"] == "false" for e in uses)
    failed = [e for e in results if e.tool_use_id == "toolu_01AYUR5ZY8bFroFxXYDWFq8y"]
    assert len(failed) == 1
    assert failed[0].tool_name == "bash"
    assert failed[0].exit_code == 1
    assert failed[0].is_error is True


def test_kind_breakdown_has_no_unknowns(copilot_tool_failure_jsonl):
    transcript = AgentTranscriptFile("copilot", copilot_tool_failure_jsonl)
    kinds = {e.kind for e in transcript.entries}

    assert EntryKind.UNKNOWN not in kinds
    assert EntryKind.TOOL_USE in kinds
    assert EntryKind.TOOL_RESULT in kinds
    assert EntryKind.ASSISTANT_MESSAGE in kinds
    assert any(isinstance(e, MetaEntry) for e in transcript.entries)
