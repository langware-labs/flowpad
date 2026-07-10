"""Codex parser — both stream-event and rollout shapes."""

from __future__ import annotations

import warnings

from flow_sdk.transcript_analyzer import (
    AgentTranscriptFile,
    AssistantMessageEntry,
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
        "\n".join(
            [
                ('{"timestamp":"2026-03-11T15:02:01.000Z","type":"session_meta","payload":{"id":"sid","cwd":"/repo"}}'),
                (
                    '{"timestamp":"2026-03-11T15:02:02.000Z","type":"response_item",'
                    '"payload":{"type":"message","role":"user","content":['
                    '{"type":"input_text","text":"<codex-prelude>internal</codex-prelude>"},'
                    '{"type":"input_text","text":"Real user prompt"}]}}'
                ),
            ]
        )
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
    assert assistants[0].text == ("I'll add a small helper. Updating helper.py to add a print_hello function.")


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
        {
            "type": "turn.completed",
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "timestamp": "2026-05-06T15:00:02.000Z",
        },
    ]
    return "\n".join(json.dumps(l) for l in lines) + "\n"


def _rollout_plan_lines(plan_body: str, *, session_id: str = "019eeee0-bbbb-7000-9000-000000000def") -> str:
    text = f"Final plan:\n<proposed_plan>\n{plan_body}\n</proposed_plan>"
    lines = [
        {
            "type": "session_meta",
            "payload": {"id": session_id, "cwd": "/repo"},
            "timestamp": "2026-05-06T15:00:00.000Z",
        },
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
        {
            "type": "turn.completed",
            "usage": {"input_tokens": 1, "output_tokens": 1},
            "timestamp": "2026-05-06T15:00:02.000Z",
        },
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


# ── usage billing semantics (validated vs real rollouts + OpenAI cumulative
#    counters, 2026-06-12) ─────────────────────────────────────────────────────


def _token_count_line(ts, *, in_t, cached, out_t, tot_in, tot_cached, tot_out):
    return {
        "timestamp": ts,
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "last_token_usage": {
                    "input_tokens": in_t,
                    "cached_input_tokens": cached,
                    "output_tokens": out_t,
                    "reasoning_output_tokens": out_t // 2,
                },
                "total_token_usage": {
                    "input_tokens": tot_in,
                    "cached_input_tokens": tot_cached,
                    "output_tokens": tot_out,
                },
            },
        },
    }


def _write_jsonl(tmp_path, name, lines):
    path = tmp_path / name
    path.write_text("\n".join(json.dumps(l) for l in lines) + "\n", encoding="utf-8")
    return path


def _usage_totals(t):
    out = {"input": 0, "output": 0, "cache_read": 0}
    for e in t.usage:
        if e.io == "output":
            out["output"] += e.count
        elif e.cache == "read":
            out["cache_read"] += e.count
        else:
            out["input"] += e.count
    return out


def test_codex_usage_bills_cumulative_increments_with_non_overlapping_dims(tmp_path):
    """input INCLUDES cached, output INCLUDES reasoning — dims must not overlap;
    billing follows the cumulative counter, not the per-turn block."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            _token_count_line("t1", in_t=1000, cached=800, out_t=50, tot_in=1000, tot_cached=800, tot_out=50),
            _token_count_line("t2", in_t=2000, cached=1900, out_t=70, tot_in=3000, tot_cached=2700, tot_out=120),
        ],
    )
    totals = _usage_totals(AgentTranscriptFile("codex", path))
    # Uncached input = total input − cached; reasoning never billed separately.
    assert totals == {"input": 300, "cache_read": 2700, "output": 120}


def test_codex_duplicate_token_count_events_billed_once(tmp_path):
    """Old-format rollouts write each token_count event twice."""
    line = _token_count_line("t1", in_t=1000, cached=800, out_t=50, tot_in=1000, tot_cached=800, tot_out=50)
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            line,
            line,
        ],
    )
    totals = _usage_totals(AgentTranscriptFile("codex", path))
    assert totals == {"input": 200, "cache_read": 800, "output": 50}


# ── naming/title classification drift guard ───────────────────────────────────
#
# Mirrors the claude ``ai-title`` guard (parsers/claude.py ``_META_TYPES``):
# a session naming/title line must classify as MetaEntry — never an
# UnknownEntry, and never a spurious "unknown entry type" warning. If codex
# ships a new naming ``event_msg`` subtype, it still falls through the parser's
# ``event_msg.<type>`` meta bucket so the transcript stays clean.


def test_codex_naming_event_msg_is_meta_not_unknown(tmp_path):
    from flow_sdk.transcript_analyzer.entries import UnknownEntry

    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {
                "timestamp": "t0",
                "type": "session_meta",
                "payload": {"id": "019dddd0-1234-7000-9000-000000000001", "cwd": "/repo"},
            },
            {
                "timestamp": "t1",
                "type": "event_msg",
                "payload": {"type": "session_title", "title": "Add a helper function"},
            },
        ],
    )

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        t = AgentTranscriptFile("codex", path)

    meta_kinds = {e.meta_kind for e in t.entries if isinstance(e, MetaEntry)}
    assert "event_msg.session_title" in meta_kinds
    assert not any(isinstance(e, UnknownEntry) for e in t.entries)
    assert not any("unknown entry type" in str(w.message) for w in caught)


def test_codex_cumulative_reset_treated_as_fresh_counter(tmp_path):
    """A cumulative drop (compaction/new task) bills the new total as delta."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            _token_count_line("t1", in_t=1000, cached=0, out_t=10, tot_in=1000, tot_cached=0, tot_out=10),
            _token_count_line("t2", in_t=400, cached=0, out_t=5, tot_in=400, tot_cached=0, tot_out=5),  # reset
        ],
    )
    totals = _usage_totals(AgentTranscriptFile("codex", path))
    assert totals == {"input": 1400, "cache_read": 0, "output": 15}


def test_custom_tool_output_list_preserves_nonzero_exit(tmp_path):
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-fail",
                    "output": [
                        {"type": "input_text", "text": "Script completed\nOutput:\n"},
                        {
                            "type": "input_text",
                            "text": (
                                '{"exit_code":7,"wall_time_seconds":0.25,'
                                '"original_token_count":3,"output":"D02_FAIL\\n"}'
                            ),
                        },
                    ],
                },
            },
        ],
    )

    result = next(e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, ToolResultEntry))
    assert result.is_error is True
    assert result.exit_code == 7
    assert result.tool_output == "D02_FAIL\n"
    assert result.duration_ms == 250


def test_custom_tool_output_list_json_missing_exit_code_falls_back_to_text(tmp_path):
    """A trailing JSON block WITHOUT ``exit_code`` is not the structured result
    object — the joined text is kept as the output, with no error flag."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-plain",
                    "output": [
                        {"type": "input_text", "text": "hello"},
                        {"type": "input_text", "text": '{"not_a_result": true}'},
                    ],
                },
            },
        ],
    )

    result = next(e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, ToolResultEntry))
    assert result.is_error is False
    assert result.exit_code is None
    assert result.tool_output == 'hello\n{"not_a_result": true}'


def test_custom_tool_output_list_last_json_result_wins_and_zero_is_not_error(tmp_path):
    """Multiple JSON-object blocks: the LAST one carrying ``exit_code`` is the
    result frame. ``exit_code == 0`` must not be flagged as an error."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-ok",
                    "output": [
                        {"type": "input_text", "text": '{"exit_code":1,"output":"stale"}'},
                        {"type": "input_text", "text": '{"exit_code":0,"output":"fresh OK\\n"}'},
                    ],
                },
            },
        ],
    )

    result = next(e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, ToolResultEntry))
    assert result.is_error is False
    assert result.exit_code == 0
    assert result.tool_output == "fresh OK\n"


def test_custom_tool_output_list_json_result_found_behind_trailing_nonjson_block(tmp_path):
    """A non-JSON block AFTER the structured result must not hide it — the
    reversed scan skips it and still decodes the exit code."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-trail",
                    "output": [
                        {"type": "input_text", "text": "Script completed\n"},
                        {"type": "input_text", "text": '{"exit_code":5,"output":"boom"}'},
                        {"type": "input_text", "text": "trailing human note"},
                    ],
                },
            },
        ],
    )

    result = next(e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, ToolResultEntry))
    assert result.is_error is True
    assert result.exit_code == 5
    assert result.tool_output == "boom"


def test_string_output_exit_code_line_preamble_is_decoded(tmp_path):
    """Real rollouts also carry the ``Exit code: N`` line form (both
    function_call_output and custom_tool_call_output). A nonzero exit must
    not read as success with the preamble left glued to the body."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "call_id": "call-exitline",
                    "output": "Exit code: 7\nWall time: 0.3 seconds\nOutput:\nno such file\n",
                },
            },
        ],
    )

    result = next(e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, ToolResultEntry))
    assert result.is_error is True
    assert result.exit_code == 7
    assert result.duration_ms == 300
    assert result.tool_output == "no such file\n"


def test_string_output_json_metadata_exit_code_is_decoded(tmp_path):
    """apply_patch-era outputs are a JSON string of the form
    ``{"output": ..., "metadata": {"exit_code": N, "duration_seconds": S}}``."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-meta",
                    "output": '{"output":"patch failed: conflict\\n","metadata":{"exit_code":2,"duration_seconds":0.5}}',
                },
            },
        ],
    )

    result = next(e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, ToolResultEntry))
    assert result.is_error is True
    assert result.exit_code == 2
    assert result.duration_ms == 500
    assert result.tool_output == "patch failed: conflict\n"


def test_internal_angle_only_user_message_is_not_a_visible_turn(tmp_path):
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "<recommended_plugins>internal</recommended_plugins>"},
                        {"type": "input_text", "text": "<environment_context>internal</environment_context>"},
                    ],
                },
            },
            {
                "timestamp": "t2",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "real prompt"}],
                },
            },
        ],
    )

    users = [e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, UserMessageEntry)]
    assert [e.text for e in users] == ["real prompt"]


def test_whitespace_only_user_message_is_not_a_visible_turn(tmp_path):
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "  \n\t "}],
                },
            },
        ],
    )

    assert not [e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, UserMessageEntry)]


def test_user_message_mixing_angle_blocks_and_real_text_keeps_the_text(tmp_path):
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "<environment_context>internal</environment_context>"},
                        {"type": "input_text", "text": "fix the bug please"},
                    ],
                },
            },
        ],
    )

    users = [e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, UserMessageEntry)]
    assert [e.text for e in users] == ["fix the bug please"]


# ── patch_apply_end mirror vs orphan semantics ───────────────────────────────
#
# Real rollouts (validated against ~/.codex/sessions 2026-07) write, per
# apply_patch call, in this order and all sharing ONE call_id:
#   response_item custom_tool_call → event_msg patch_apply_end
#   → response_item custom_tool_call_output
# The event_msg is a transport mirror of the canonical output. Some rollouts
# (forked/event_msg-only histories, or turns killed between the two writes)
# carry the patch_apply_end WITHOUT the custom_tool_call_output — that mirror
# is then the ONLY durable record of the apply result and must not vanish.

_APPLY_PATCH_UPDATE = "*** Begin Patch\n*** Update File: b.py\n@@\n-old\n+new\n*** End Patch\n"


def test_patch_apply_end_transport_mirror_is_not_an_orphan_result(tmp_path):
    """When the canonical custom_tool_call_output exists, the patch_apply_end
    mirror must not surface as a second/orphan result row."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "event_msg",
                "payload": {
                    "type": "patch_apply_end",
                    "call_id": "call-77",
                    "success": True,
                    "stdout": "Success. Updated the following files:\nM b.py\n",
                    "stderr": "",
                },
            },
            {
                "timestamp": "t2",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call_output",
                    "call_id": "call-77",
                    "output": "canonical output",
                },
            },
        ],
    )

    results = [e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, ToolResultEntry)]
    assert len(results) == 1
    assert results[0].tool_output == "canonical output"


def test_orphaned_patch_apply_end_still_yields_a_result(tmp_path):
    """Event_msg-only rollout: patch_apply_end with NO custom_tool_call_output
    anywhere. The mirror is the only record — it must survive as a durable
    result frame instead of vanishing silently."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "event_msg",
                "payload": {
                    "type": "patch_apply_end",
                    "call_id": "call-orphan",
                    "success": True,
                    "stdout": "Success. Updated the following files:\nM b.py\n",
                    "stderr": "",
                },
            },
        ],
    )

    results = [e for e in AgentTranscriptFile("codex", path).entries if isinstance(e, ToolResultEntry)]
    assert len(results) == 1
    assert results[0].tool_use_id == "call-orphan"
    assert results[0].is_error is False
    assert "Updated the following files" in results[0].tool_output


def test_orphaned_failed_patch_apply_end_marks_file_ops_as_errored(tmp_path):
    """Turn killed between patch_apply_end and custom_tool_call_output: the
    semantic file ops must still end up in a derivable failed state."""
    path = _write_jsonl(
        tmp_path,
        "rollout.jsonl",
        [
            {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
            {
                "timestamp": "t1",
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "apply_patch",
                    "call_id": "call-killed",
                    "input": _APPLY_PATCH_UPDATE,
                },
            },
            {
                "timestamp": "t2",
                "type": "event_msg",
                "payload": {
                    "type": "patch_apply_end",
                    "call_id": "call-killed",
                    "success": False,
                    "stdout": "",
                    "stderr": "apply failed: conflict in b.py",
                },
            },
        ],
    )

    from flow_sdk.transcript_analyzer.entries import FileEditEntry

    t = AgentTranscriptFile("codex", path)
    edit = next(e for e in t.entries if isinstance(e, FileEditEntry))
    assert edit.is_error is True
