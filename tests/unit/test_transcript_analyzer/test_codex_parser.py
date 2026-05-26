"""Codex parser — both stream-event and rollout shapes."""

from __future__ import annotations

import warnings

from flow_sdk.transcript_analyzer import (
    AgentTranscriptFile,
    AssistantMessageEntry,
    EntryKind,
    MetaEntry,
    SystemEntry,
    ToolResultEntry,
    ToolUseEntry,
    UnknownEntry,
    UserMessageEntry,
)
from flow_sdk.transcript_analyzer import TranscriptFormat


# ── stream-event shape ────────────────────────────────────────────────────────


def test_stream_session_id_from_thread_started(codex_stream_jsonl):
    t = AgentTranscriptFile("codex", codex_stream_jsonl)
    assert t.session_id == "019dddd0-1234-7000-9000-000000000001"


def test_stream_parser_can_be_selected_by_format(codex_stream_jsonl):
    t = AgentTranscriptFile(
        "codex",
        codex_stream_jsonl,
        transcript_format=TranscriptFormat.CODEX_STREAM,
    )
    assert t.prompts == []
    assert t.session_id == "019dddd0-1234-7000-9000-000000000001"


def test_stream_no_unknown_entries(codex_stream_jsonl):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        t = AgentTranscriptFile("codex", codex_stream_jsonl)
    assert not any(isinstance(e, UnknownEntry) for e in t.entries)
    assert not any("unknown entry type" in str(w.message) for w in caught)


def test_stream_kind_breakdown(codex_stream_jsonl):
    t = AgentTranscriptFile("codex", codex_stream_jsonl)
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
    t = AgentTranscriptFile("codex", codex_stream_jsonl)
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
    t = AgentTranscriptFile("codex", codex_stream_jsonl)
    msgs = [e for e in t.entries if isinstance(e, AssistantMessageEntry)]
    assert len(msgs) == 1
    assert msgs[0].text == "Adding the helper function now."


def test_stream_session_id_propagated_to_all_entries(codex_stream_jsonl):
    t = AgentTranscriptFile("codex", codex_stream_jsonl)
    expected = "019dddd0-1234-7000-9000-000000000001"
    # The first line itself is thread.started — by the time we yield its
    # SystemEntry, the parser has captured thread_id, so every entry
    # (including the very first) carries the session id.
    for e in t.entries:
        assert e.session_id == expected


# ── rollout shape ─────────────────────────────────────────────────────────────


def test_rollout_session_id_from_session_meta(codex_rollout_jsonl):
    t = AgentTranscriptFile("codex", codex_rollout_jsonl)
    assert t.session_id == "019cdd6b-49a7-7480-9da1-aaaaaaaaaaaa"


def test_rollout_parser_can_be_selected_by_format(codex_rollout_jsonl):
    t = AgentTranscriptFile(
        "codex",
        codex_rollout_jsonl,
        transcript_format=TranscriptFormat.CODEX_ROLLOUT,
    )
    prompts = t.prompts
    assert len(prompts) == 1
    assert prompts[0].text == "Add a small helper function that prints hello."


def test_rollout_prompts_skip_codex_prelude_blocks(tmp_path):
    transcript_path = tmp_path / "rollout.jsonl"
    transcript_path.write_text(
        "\n".join([
            (
                '{"timestamp":"2026-03-11T15:02:01.000Z","type":"session_meta",'
                '"payload":{"id":"sid","cwd":"/repo"}}'
            ),
            (
                '{"timestamp":"2026-03-11T15:02:02.000Z","type":"response_item",'
                '"payload":{"type":"message","role":"user","content":['
                '{"type":"input_text","text":"<codex-prelude>internal</codex-prelude>"},'
                '{"type":"input_text","text":"Real user prompt"}]}}'
            ),
        ])
        + "\n",
        encoding="utf-8",
    )

    t = AgentTranscriptFile(
        "codex",
        transcript_path,
        transcript_format=TranscriptFormat.CODEX_ROLLOUT,
    )

    assert [p.text for p in t.prompts] == ["Real user prompt"]


def test_rollout_user_and_assistant_messages(codex_rollout_jsonl):
    t = AgentTranscriptFile("codex", codex_rollout_jsonl)
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
        t = AgentTranscriptFile("codex", codex_rollout_jsonl)
    assert not any(isinstance(e, UnknownEntry) for e in t.entries)
    assert not any("unknown entry type" in str(w.message) for w in caught)


def test_rollout_session_meta_is_meta_entry(codex_rollout_jsonl):
    t = AgentTranscriptFile("codex", codex_rollout_jsonl)
    metas = [e for e in t.entries if isinstance(e, MetaEntry)]
    meta_kinds = {e.meta_kind for e in metas}
    assert "session_meta" in meta_kinds


# ── plan-mode (<proposed_plan>) synthesis ─────────────────────────────────────

import json
from flow_sdk.transcript_analyzer import ExitPlanModeEntry
from flow_sdk.instance_settings import get_instance_settings


def _stream_plan_lines(plan_body: str, *, thread_id: str = "019eeee0-aaaa-7000-9000-000000000abc") -> str:
    text = f"Here is the finalized plan.\n<proposed_plan>\n{plan_body}\n</proposed_plan>"
    lines = [
        {"type": "thread.started", "thread_id": thread_id, "timestamp": "2026-05-06T15:00:00.000Z"},
        {"type": "turn.started", "timestamp": "2026-05-06T15:00:00.000Z"},
        {
            "type": "item.completed",
            "item": {"id": "item_plan_001", "type": "agent_message", "text": text},
            "timestamp": "2026-05-06T15:00:01.000Z",
        },
        {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}, "timestamp": "2026-05-06T15:00:02.000Z"},
    ]
    return "\n".join(json.dumps(l) for l in lines) + "\n"


def _rollout_plan_lines(plan_body: str, *, session_id: str = "019eeee0-bbbb-7000-9000-000000000def") -> str:
    text = f"Final plan:\n<proposed_plan>\n{plan_body}\n</proposed_plan>"
    lines = [
        {"type": "session_meta", "payload": {"id": session_id, "cwd": "/repo"}, "timestamp": "2026-05-06T15:00:00.000Z"},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            },
            "timestamp": "2026-05-06T15:00:01.000Z",
        },
    ]
    return "\n".join(json.dumps(l) for l in lines) + "\n"


def test_stream_proposed_plan_becomes_exit_plan_mode_entry(tmp_path):
    jsonl = tmp_path / "stream.jsonl"
    body = "# Step 1\nDo X\n# Step 2\nDo Y"
    jsonl.write_text(_stream_plan_lines(body), encoding="utf-8")

    t = AgentTranscriptFile("codex", jsonl)

    matches = [e for e in t.entries if isinstance(e, ExitPlanModeEntry)]
    assert len(matches) == 1
    e = matches[0]
    assert e.tool_name == "ExitPlanMode"
    assert e.plan_text == body
    expected_path = str(get_instance_settings().claude_plans_dir / f"codex-{t.session_id}.md")
    assert e.plan_file_path == expected_path

    # The original AssistantMessageEntry is still present (synthesis is additive).
    assert any(isinstance(x, AssistantMessageEntry) for x in t.entries)

    # `latest_tool_use("ExitPlanMode")` and `latest_plan` both return it.
    assert t.latest_tool_use("ExitPlanMode") is e
    assert t.latest_plan is e


def test_rollout_proposed_plan_becomes_exit_plan_mode_entry(tmp_path):
    jsonl = tmp_path / "rollout.jsonl"
    body = "## Phase A\nfoo\n## Phase B\nbar"
    jsonl.write_text(_rollout_plan_lines(body), encoding="utf-8")

    t = AgentTranscriptFile("codex", jsonl)
    matches = [e for e in t.entries if isinstance(e, ExitPlanModeEntry)]
    assert len(matches) == 1
    e = matches[0]
    assert e.tool_name == "ExitPlanMode"
    assert e.plan_text == body
    expected_path = str(get_instance_settings().claude_plans_dir / f"codex-{t.session_id}.md")
    assert e.plan_file_path == expected_path
    assert t.latest_plan is e


def test_assistant_message_without_proposed_plan_emits_no_entry(tmp_path):
    jsonl = tmp_path / "stream_noplan.jsonl"
    lines = [
        {"type": "thread.started", "thread_id": "sid_x", "timestamp": "2026-05-06T15:00:00.000Z"},
        {"type": "turn.started", "timestamp": "2026-05-06T15:00:00.000Z"},
        {
            "type": "item.completed",
            "item": {"id": "i1", "type": "agent_message", "text": "Just a chat reply, no plan."},
            "timestamp": "2026-05-06T15:00:01.000Z",
        },
        {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}, "timestamp": "2026-05-06T15:00:02.000Z"},
    ]
    jsonl.write_text("\n".join(json.dumps(l) for l in lines) + "\n", encoding="utf-8")

    t = AgentTranscriptFile("codex", jsonl)
    assert not [e for e in t.entries if isinstance(e, ExitPlanModeEntry)]
    assert t.latest_plan is None


def test_update_plan_does_not_become_plan(tmp_path):
    """Codex's TODO-checklist tool `update_plan` is NOT Plan Mode."""
    jsonl = tmp_path / "rollout_update_plan.jsonl"
    lines = [
        {"type": "session_meta", "payload": {"id": "sid_y", "cwd": "/repo"}, "timestamp": "2026-05-06T15:00:00.000Z"},
        {
            "type": "response_item",
            "payload": {
                "type": "function_call",
                "name": "update_plan",
                "call_id": "call_1",
                "arguments": json.dumps({"plan": [{"step": "foo", "status": "pending"}]}),
            },
            "timestamp": "2026-05-06T15:00:01.000Z",
        },
    ]
    jsonl.write_text("\n".join(json.dumps(l) for l in lines) + "\n", encoding="utf-8")

    t = AgentTranscriptFile("codex", jsonl)
    # update_plan still parses as a generic ToolUseEntry...
    assert any(isinstance(e, ToolUseEntry) and e.tool_name == "update_plan" for e in t.entries)
    # ...but is NOT considered the plan.
    assert t.latest_plan is None
