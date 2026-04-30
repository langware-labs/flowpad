"""Codex parser — both stream-event and rollout shapes."""

from __future__ import annotations

import warnings

from flow_sdk.transcript_analyzer import (
    AgentTranscript,
    AssistantMessageEntry,
    EntryKind,
    MetaEntry,
    SystemEntry,
    ToolResultEntry,
    ToolUseEntry,
    UnknownEntry,
    UserMessageEntry,
)


# ── stream-event shape ────────────────────────────────────────────────────────


def test_stream_session_id_from_thread_started(codex_stream_jsonl):
    t = AgentTranscript("codex", codex_stream_jsonl)
    assert t.session_id == "019dddd0-1234-7000-9000-000000000001"


def test_stream_no_unknown_entries(codex_stream_jsonl):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        t = AgentTranscript("codex", codex_stream_jsonl)
    assert not any(isinstance(e, UnknownEntry) for e in t.entries)
    assert not any("unknown entry type" in str(w.message) for w in caught)


def test_stream_kind_breakdown(codex_stream_jsonl):
    t = AgentTranscript("codex", codex_stream_jsonl)
    counts: dict[str, int] = {}
    for e in t.entries:
        counts[e.kind.value] = counts.get(e.kind.value, 0) + 1
    # 7 raw lines but command_execution synthesizes a tool_use + tool_result
    # pair from one line, so total entries = 8.
    #   thread.started, turn.started, turn.completed → 3 SYSTEM
    #   item.started, file_change → 2 META
    #   item.completed:agent_message → 1 ASSISTANT_MESSAGE
    #   item.completed:command_execution → 1 TOOL_USE + 1 TOOL_RESULT
    assert counts == {
        "system": 3,
        "meta": 2,
        "assistant_message": 1,
        "tool_use": 1,
        "tool_result": 1,
    }


def test_stream_command_execution_synthesizes_tool_use_pair(codex_stream_jsonl):
    t = AgentTranscript("codex", codex_stream_jsonl)
    uses = [e for e in t.entries if isinstance(e, ToolUseEntry)]
    results = [e for e in t.entries if isinstance(e, ToolResultEntry)]
    assert len(uses) == 1
    assert len(results) == 1
    assert uses[0].tool_name == "shell"
    assert uses[0].tool_input == {"command": "ls /repo"}
    assert uses[0].tool_use_id == "item_002"
    assert results[0].tool_use_id == "item_002"
    assert results[0].tool_name == "shell"
    assert "helper.py" in results[0].tool_output
    assert results[0].is_error is False


def test_stream_assistant_message(codex_stream_jsonl):
    t = AgentTranscript("codex", codex_stream_jsonl)
    msgs = [e for e in t.entries if isinstance(e, AssistantMessageEntry)]
    assert len(msgs) == 1
    assert msgs[0].text == "Adding the helper function now."


def test_stream_session_id_propagated_to_all_entries(codex_stream_jsonl):
    t = AgentTranscript("codex", codex_stream_jsonl)
    expected = "019dddd0-1234-7000-9000-000000000001"
    # The first line itself is thread.started — by the time we yield its
    # SystemEntry, the parser has captured thread_id, so every entry
    # (including the very first) carries the session id.
    for e in t.entries:
        assert e.session_id == expected


# ── rollout shape ─────────────────────────────────────────────────────────────


def test_rollout_session_id_from_session_meta(codex_rollout_jsonl):
    t = AgentTranscript("codex", codex_rollout_jsonl)
    assert t.session_id == "019cdd6b-49a7-7480-9da1-aaaaaaaaaaaa"


def test_rollout_user_and_assistant_messages(codex_rollout_jsonl):
    t = AgentTranscript("codex", codex_rollout_jsonl)
    users = [e for e in t.entries if isinstance(e, UserMessageEntry)]
    assistants = [e for e in t.entries if isinstance(e, AssistantMessageEntry)]
    assert len(users) == 1
    assert len(assistants) == 1
    assert users[0].text == "Add a small helper function that prints hello."
    assert assistants[0].text == (
        "I'll add a small helper. Updating helper.py to add a print_hello function."
    )


def test_rollout_no_unknown_entries(codex_rollout_jsonl):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        t = AgentTranscript("codex", codex_rollout_jsonl)
    assert not any(isinstance(e, UnknownEntry) for e in t.entries)
    assert not any("unknown entry type" in str(w.message) for w in caught)


def test_rollout_session_meta_is_meta_entry(codex_rollout_jsonl):
    t = AgentTranscript("codex", codex_rollout_jsonl)
    metas = [e for e in t.entries if isinstance(e, MetaEntry)]
    meta_kinds = {e.meta_kind for e in metas}
    assert "session_meta" in meta_kinds
