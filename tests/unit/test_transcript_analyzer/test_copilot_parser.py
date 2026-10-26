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
from flow_sdk.transcript_analyzer.entries import (
    FileEditEntry,
    FileReadEntry,
    FileWriteEntry,
    ShellCommandEntry,
    UnknownEntry,
)
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
    shells = [e for e in transcript.entries if isinstance(e, ShellCommandEntry)]

    # Copilot's ``bash`` maps onto the semantic ShellCommandEntry, same as
    # Claude's ``Bash`` — so the UI renders one chip shape for both workers,
    # and the failed result folds INTO the call (one row per operation) rather
    # than surviving as a standalone ToolResultEntry.
    failed = [e for e in shells if e.tool_use_id == "toolu_01AYUR5ZY8bFroFxXYDWFq8y"]
    assert len(failed) == 1
    assert failed[0].tool_name == "bash"
    assert failed[0].command == "false"
    assert failed[0].exit_code == 1
    assert failed[0].is_error is True
    assert not any(
        isinstance(e, ToolResultEntry) and e.tool_use_id == "toolu_01AYUR5ZY8bFroFxXYDWFq8y"
        for e in transcript.entries
    )


def test_kind_breakdown_has_no_unknowns(copilot_tool_failure_jsonl):
    transcript = AgentTranscriptFile("copilot", copilot_tool_failure_jsonl)
    kinds = {e.kind for e in transcript.entries}

    assert EntryKind.UNKNOWN not in kinds
    assert EntryKind.SHELL_COMMAND in kinds
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


# ── semantic tool mapping ────────────────────────────────────────────────────
#
# Copilot names its file tools differently from Claude and publishes no stable
# list, so the parser recognizes file ops by INPUT SHAPE. These lock the shapes
# down: without them a Copilot session renders generic wrench rows while the
# same operations render as file chips under Claude.


def _copilot_tool_entry(name: str, arguments: dict):
    parser = CopilotParser(session_id="s1")
    [entry] = parser.feed(
        {
            "type": "assistant.message",
            "data": {
                "messageId": "m1",
                "content": "",
                "toolRequests": [
                    {"toolCallId": "tc1", "name": name, "type": "function", "arguments": arguments}
                ],
            },
        },
        0,
    )
    return entry


def test_path_plus_content_is_a_file_write():
    entry = _copilot_tool_entry("create", {"path": "/tmp/a.txt", "content": "hello"})

    assert isinstance(entry, FileWriteEntry)
    assert entry.path == "/tmp/a.txt"
    assert entry.line_count == 1


def test_path_plus_old_new_is_a_file_edit():
    entry = _copilot_tool_entry(
        "str_replace", {"path": "/tmp/a.txt", "old_str": "a", "new_str": "b"}
    )

    assert isinstance(entry, FileEditEntry)
    assert entry.hunks == [{"old": "a", "new": "b", "replace_all": False}]


def test_bare_path_on_a_read_ish_tool_is_a_file_read():
    entry = _copilot_tool_entry("view", {"path": "/tmp/a.txt"})

    assert isinstance(entry, FileReadEntry)
    assert entry.path == "/tmp/a.txt"


def test_bare_path_on_an_unrelated_tool_stays_generic():
    entry = _copilot_tool_entry("lint", {"path": "/tmp/a.txt"})

    assert isinstance(entry, ToolUseEntry)
    assert not isinstance(entry, FileReadEntry)


def test_mcp_tool_with_a_path_key_is_never_a_file_op():
    entry = _copilot_tool_entry("mcp__server__read", {"path": "/tmp/a.txt"})

    assert type(entry) is ToolUseEntry


def _shutdown(output=76, model="model-a", **counts):
    details = {key: {"tokenCount": value} for key, value in
               {"input": 23410, "cache_read": 6016, "cache_write": 0, "output": output, **counts}.items()}
    return {"type": "session.shutdown", "data": {
        "currentModel": model, "tokenDetails": details,
        "modelMetrics": {model: {"tokenDetails": details}},
    }}


def _usage_totals(entries):
    from flow_sdk.transcript_analyzer.entries.usage import UsageEntry
    totals = {}
    for entry in entries:
        if isinstance(entry, UsageEntry):
            key = (entry.model, entry.io, entry.cache)
            totals[key] = totals.get(key, 0) + entry.count
    return {key: count for key, count in totals.items() if count}


def test_shutdown_reports_exact_exclusive_token_dimensions():
    entries = CopilotParser().feed(_shutdown(), 0)
    assert _usage_totals(entries) == {
        ("model-a", "input", "none"): 23410,
        ("model-a", "input", "read"): 6016,
        ("model-a", "output", "none"): 76,
    }


def test_resumed_shutdowns_are_cumulative_and_duplicate_safe():
    parser = CopilotParser()
    entries = parser.feed(_shutdown(11), 0)
    entries += parser.feed(_shutdown(11), 1)
    entries += parser.feed(_shutdown(22), 2)
    assert _usage_totals(entries)[("model-a", "output", "none")] == 22


def test_shutdown_replaces_legacy_output_even_without_message_model():
    parser = CopilotParser()
    message = {"type": "assistant.message", "id": "m1", "data": {"outputTokens": 11}}
    entries = parser.feed(message, 0) + parser.feed(message, 1)
    assert sum(_usage_totals(entries).values()) == 11
    entries += parser.feed(_shutdown(22), 2)
    assert _usage_totals(entries).get((None, "output", "none"), 0) == 0
    assert _usage_totals(entries)[("model-a", "output", "none")] == 22
    entries += parser.feed({**message, "id": "m2"}, 3)
    entries += parser.feed(_shutdown(33), 4)
    assert _usage_totals(entries)[("model-a", "output", "none")] == 33


def test_shutdown_keeps_cumulative_totals_separate_per_model():
    parser = CopilotParser()
    entries = parser.feed(_shutdown(11), 0)
    second = _shutdown(7, model="model-b")
    second["data"]["modelMetrics"].update(_shutdown(11)["data"]["modelMetrics"])
    entries += parser.feed(second, 1)
    totals = _usage_totals(entries)
    assert totals[("model-a", "output", "none")] == 11
    assert totals[("model-b", "output", "none")] == 7
