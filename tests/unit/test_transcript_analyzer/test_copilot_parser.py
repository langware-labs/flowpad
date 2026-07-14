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
    TranscriptFormat,
    UserMessageEntry,
)
from flow_sdk.transcript_analyzer.entries import UnknownEntry
from flow_sdk.transcript_analyzer.parsers.copilot import CopilotParser


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
    assert [p.text for p in transcript.prompts] == ["Say stdin-ok in one sentence."]


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

    assert users[0].text == "Say stdin-ok in one sentence."
    assert any(e.text == "stdin-ok." for e in assistants)
    assert any(e.thinking and "straightforward request" in e.thinking for e in assistants)


def test_user_message_drops_one_stdin_terminator_only():
    parser = CopilotParser(session_id="copilot-session")

    [one] = parser.feed(
        {"type": "user.message", "data": {"content": "hello\r\n"}},
        0,
    )
    [two] = parser.feed(
        {"type": "user.message", "data": {"content": "kept newline\n\n"}},
        1,
    )
    [none] = parser.feed(
        {"type": "user.message", "data": {"content": "no terminator"}},
        2,
    )
    [carriage_return] = parser.feed(
        {"type": "user.message", "data": {"content": "intentional\r"}},
        3,
    )

    assert one.text == "hello"
    assert two.text == "kept newline\n"
    assert none.text == "no terminator"
    assert carriage_return.text == "intentional\r"


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


# ── naming/title classification drift guard ───────────────────────────────────
#
# Mirrors the claude ``ai-title`` guard: a session naming/title line must
# classify as MetaEntry with its ``meta_kind`` preserved — never an
# UnknownEntry. Copilot buckets every ``session.*`` control line as meta, so a
# future ``session.title`` naming event stays out of the chat stream while
# keeping its type visible for downstream consumers.


def test_copilot_session_title_is_meta_not_unknown(tmp_path):
    import json

    path = tmp_path / "copilot_named.jsonl"
    path.write_text(
        "\n".join(
            [
                json.dumps({"type": "result", "sessionId": "cop-name-1", "timestamp": "t0"}),
                json.dumps({"type": "session.title", "timestamp": "t1", "data": {"title": "Add a helper function"}}),
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        transcript = AgentTranscriptFile("copilot", path)

    meta_kinds = {e.meta_kind for e in transcript.entries if isinstance(e, MetaEntry)}
    assert "session.title" in meta_kinds
    assert not any(isinstance(e, UnknownEntry) for e in transcript.entries)
    assert not any("unknown entry type" in str(w.message) for w in caught)
