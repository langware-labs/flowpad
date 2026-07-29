"""Claude parser dispatch + ExitPlanMode extraction."""

from __future__ import annotations

import warnings

import pytest

from flow_sdk.transcript_analyzer import (
    AgentTranscriptFile,
    AssistantMessageEntry,
    EntryKind,
    ExitPlanModeEntry,
    MetaEntry,
    ShellCommandEntry,
    SystemEntry,
    UnknownEntry,
    UserMessageEntry,
)
from flow_sdk.transcript_analyzer.entries import WorkerUnavailableEntry
from flow_sdk.transcript_analyzer.parsers.claude import ClaudeParser


def test_parses_all_lines_with_one_warning_for_unknown(claude_jsonl):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        t = AgentTranscriptFile("claude", claude_jsonl)
    # 12 raw lines; Bash is parsed as shell_command and its tool_result is
    # folded into that operation → -1. Each of the 3 assistant turns emits
    # 4 per-dim UsageEntry (input + output + cache_read + cache_write_1h)
    # → +12. Net: 12 - 1 + 12 = 23.
    assert len(t) == 23
    # One synthetic unknown line at the end → exactly one warning.
    unknown_warnings = [w for w in caught if "unknown entry type" in str(w.message)]
    assert len(unknown_warnings) == 1
    assert "totally-novel-type-future-claude" in str(unknown_warnings[0].message)


def test_session_id_propagates_from_first_line(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    assert t.session_id == "11111111-1111-4111-8111-111111111111"
    # Every entry that carries sessionId in its raw line should have it.
    for e in t.entries:
        if e.kind is not EntryKind.UNKNOWN:
            assert e.session_id == "11111111-1111-4111-8111-111111111111"


def test_entry_kind_breakdown(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    counts: dict[str, int] = {}
    for e in t.entries:
        counts[e.kind.value] = counts.get(e.kind.value, 0) + 1
    # Fixture composition (see scripts that built it):
    #   permission-mode, file-history-snapshot, attachment, last-prompt,
    #   queue-operation → 5 META
    #   user text → 1 USER_MESSAGE
    #   assistant text → 1 ASSISTANT_MESSAGE
    #   Bash tool_use + tool_result → 1 SHELL_COMMAND
    #   ExitPlanMode tool_use → 1 TOOL_USE
    #   system:stop_hook_summary → 1 SYSTEM
    #   synthetic unknown → 1 UNKNOWN
    # Each assistant turn emits 4 per-dim UsageEntry (input + output +
    # cache_read + cache_write_1h) from the realistic usage block in the
    # fixture. 3 turns × 4 dims = 12 token_usage entries.
    assert counts == {
            "meta": 5,
            "user_message": 1,
            "assistant_message": 1,
            "tool_use": 1,
            "shell_command": 1,
            "system": 1,
            "unknown": 1,
            "token_usage": 12,
    }


def test_latest_tool_use_resolves_exit_plan_mode(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    plan = t.latest_tool_use("ExitPlanMode")
    assert plan is not None
    assert isinstance(plan, ExitPlanModeEntry)
    assert plan.plan_file_path == "/Users/sample/.claude/plans/sample-plan-name.md"
    assert plan.plan_text.startswith("# Sample plan")
    assert plan.tool_use_id == "toolu_sample_plan_001"


def test_latest_tool_use_for_unknown_tool_returns_none(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    assert t.latest_tool_use("DoesNotExist") is None


def test_unknown_entry_carries_raw_data(claude_jsonl):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t = AgentTranscriptFile("claude", claude_jsonl)
    unknowns = [e for e in t.entries if isinstance(e, UnknownEntry)]
    assert len(unknowns) == 1
    raw = unknowns[0].raw_data
    assert raw is not None
    assert raw.get("type") == "totally-novel-type-future-claude"
    assert raw.get("weirdField") == "value"


def test_known_entries_have_raw_data_none(claude_jsonl):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t = AgentTranscriptFile("claude", claude_jsonl)
    # All non-UnknownEntry entries should have raw_data is None per the
    # design (parsers extract what they need at parse time).
    for e in t.entries:
        if isinstance(e, UnknownEntry):
            continue
        assert e.raw_data is None, f"{type(e).__name__} unexpectedly carries raw_data"


def test_filter_by_kind(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    assistants = list(t.filter(kind=EntryKind.ASSISTANT_MESSAGE))
    assert all(isinstance(e, AssistantMessageEntry) for e in assistants)
    assert len(assistants) == 1


def test_filter_by_tool_name(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    bashes = list(t.filter(tool_name="Bash"))
    assert len(bashes) == 1
    assert isinstance(bashes[0], ShellCommandEntry)
    assert bashes[0].tool_name == "Bash"
    assert bashes[0].command == "echo ok"


def test_shell_command_folds_tool_result_fields(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    commands = [e for e in t.entries if isinstance(e, ShellCommandEntry)]
    assert len(commands) == 1
    cmd = commands[0]
    assert cmd.tool_use_id == "toolu_sample_bash_001"
    assert "ok" in (cmd.stdout_preview or "")


def test_user_message_entry_fields(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    users = [e for e in t.entries if isinstance(e, UserMessageEntry)]
    assert len(users) == 1
    assert users[0].text  # non-empty after sanitization


def test_flowpad_embedded_agent_prompt_envelope_is_meta():
    parser = ClaudeParser()
    text = (
        "# You are the 'vibe' agent\n"
        "The user is chatting with you (this agent) directly.\n\n"
        "## Instructions\n"
        "Internal routing instructions.\n\n"
        "# User message\n"
        "Open the app"
    )
    entries = parser.feed(
        {
            "type": "user",
            "message": {"content": [{"type": "text", "text": text}]},
            "uuid": "u1",
        },
        0,
    )

    assert len(entries) == 1
    assert isinstance(entries[0], UserMessageEntry)
    assert entries[0].is_meta is True


def test_weekly_limit_assistant_becomes_worker_unavailable():
    entries = ClaudeParser().feed(
        {
            "type": "assistant",
            "error": "rate_limit",
            "isApiErrorMessage": True,
            "apiErrorStatus": 429,
            "uuid": "quota-event",
            "sessionId": "quota-session",
            "message": {
                "model": "<synthetic>",
                "stop_reason": "stop_sequence",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "You've hit your weekly limit · resets 3pm "
                            "(Asia/Jerusalem)"
                        ),
                    }
                ],
            },
        },
        0,
    )

    assert len(entries) == 1
    entry = entries[0]
    assert isinstance(entry, WorkerUnavailableEntry)
    assert entry.reason == "quota_exhausted"
    assert entry.worker == "claude"
    assert entry.worker_type == "claude_code"
    assert entry.provider_error == "rate_limit"
    assert entry.status_code == 429
    assert entry.recoverable_with_alternative is True


@pytest.mark.parametrize(
    "error_fields",
    [
        {"error": "rate_limit"},
        {"isApiErrorMessage": True, "apiErrorStatus": "429"},
    ],
)
def test_each_rate_limit_signal_is_sufficient(error_fields):
    entries = ClaudeParser().feed(
        {
            "type": "assistant",
            **error_fields,
            "message": {
                "content": [{"type": "text", "text": "Please try again later."}],
            },
        },
        0,
    )

    assert isinstance(entries[0], WorkerUnavailableEntry)
    assert entries[0].reason == "rate_limited"


def test_meta_kind_propagation(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    metas = [e for e in t.entries if isinstance(e, MetaEntry)]
    kinds = sorted(e.meta_kind for e in metas)
    assert kinds == [
        "attachment",
        "file-history-snapshot",
        "last-prompt",
        "permission-mode",
        "queue-operation",
    ]


def test_system_entry_subtype(claude_jsonl):
    t = AgentTranscriptFile("claude", claude_jsonl)
    systems = [e for e in t.entries if isinstance(e, SystemEntry)]
    assert len(systems) == 1
    assert systems[0].subtype == "stop_hook_summary"


# ── multi-block-per-message folding ──────────────────────────────────────────
#
# A single Anthropic assistant message can carry multiple content blocks
# (thinking, text, tool_use). Claude Code's JSONL writes one block per
# line, all sharing the same ``message.id``. The parser owns folding
# those back into one logical TranscriptEntry per message so the viewer
# never has to dedup snapshots downstream.

def test_multi_block_message_folds_to_one_assistant_entry(claude_multi_block_jsonl):
    """thinking+text+tool_use sharing a msg_id → one AssistantMessageEntry
    carrying both text and thinking, plus one paired semantic tool entry."""
    t = AgentTranscriptFile("claude", claude_multi_block_jsonl)

    # Fixture composition:
    #   1 user prompt
    #   msg_01AK5K… — text only           → 1 AssistantMessageEntry
    #   msg_014RK… — thinking + text      → 1 AssistantMessageEntry
    #   msg_01H3U… — thinking + text +    → 1 AssistantMessageEntry
    #                tool_use(Bash)         + 1 ShellCommandEntry
    assistants = [e for e in t.entries if isinstance(e, AssistantMessageEntry)]
    assert len(assistants) == 3, (
        f"expected one AssistantMessageEntry per Anthropic message.id, "
        f"got {len(assistants)}: {[(a.entry_id, bool(a.text), bool(a.thinking)) for a in assistants]}"
    )

    by_id = {a.entry_id: a for a in assistants}

    # Text-only message: text present, no thinking.
    a1 = by_id.get("msg_01AK5KwbW3YHNLZgh1d79MMv")
    assert a1 is not None
    assert a1.text  # carries the assistant's reply text
    assert a1.thinking in (None, "")  # no thinking block on this turn

    # Thinking+text: both fields populated on the SAME entry.
    a2 = by_id.get("msg_014RKDVYoQr1qrPiv36Ls37B")
    assert a2 is not None, "thinking+text message must surface as one entry"
    assert a2.text, "text block was dropped during parse"
    # The signature-only redacted-thinking case is OK (thinking="" or None);
    # this fixture preserves the real blocks, so the field exists on the
    # entry — even if empty when redacted upstream.
    assert hasattr(a2, "thinking")

    # Thinking+text+tool_use: AssistantMessageEntry carries text;
    # the tool_use becomes its own ShellCommandEntry sharing entry_id.
    a3 = by_id.get("msg_01H3UDnfJMZD6qUMf7v933L9")
    assert a3 is not None, "text block was dropped when followed by tool_use"
    assert a3.text, "text block must survive even when a tool_use follows"

    shells = [e for e in t.entries if isinstance(e, ShellCommandEntry)]
    assert len(shells) == 1, f"expected exactly one ShellCommandEntry, got {len(shells)}"
    assert shells[0].entry_id == "msg_01H3UDnfJMZD6qUMf7v933L9", (
        "ShellCommandEntry must share entry_id with its parent assistant message "
        "so the viewer can group them as one turn"
    )
    assert shells[0].command, "command was not extracted from tool_input"


def test_plan_mode_exit_attachment_becomes_exit_plan_mode_entry(tmp_path):
    """plan_mode_exit attachments are surfaced as ExitPlanModeEntry.

    Real-world finding from session ff041ecd-…: plan mode is driven via
    `attachment.type="plan_mode_exit"` lines that carry `planFilePath`,
    not via tool_use:ExitPlanMode. The claude parser must synthesize an
    ExitPlanModeEntry from these so the existing PlanHandler
    (match_tool_name="ExitPlanMode") catches them unchanged.
    """
    import json
    sid = "22222222-2222-4222-8222-222222222222"
    plan_path = "/Users/sample/.claude/plans/sample.md"
    user_line = {
        "type": "user",
        "uuid": "00000000-0000-4000-8000-0000000000c9",
        "sessionId": sid,
        "timestamp": "2026-05-21T07:00:00.000Z",
        "message": {"role": "user", "content": "hi"},
    }
    plan_exit_line = {
        "type": "attachment",
        "uuid": "00000000-0000-4000-8000-0000000000ff",
        "sessionId": sid,
        "timestamp": "2026-05-21T07:01:00.000Z",
        "attachment": {
            "type": "plan_mode_exit",
            "planFilePath": plan_path,
            "planExists": True,
        },
    }
    jsonl = tmp_path / f"{sid}.jsonl"
    jsonl.write_text(json.dumps(user_line) + "\n" + json.dumps(plan_exit_line) + "\n", encoding="utf-8")

    t = AgentTranscriptFile("claude", jsonl)
    matches = [e for e in t.entries if isinstance(e, ExitPlanModeEntry)]
    assert len(matches) == 1
    assert matches[0].plan_file_path == plan_path
    assert matches[0].session_id == sid
    # filter(tool_name="ExitPlanMode") must also catch the synthesized entry.
    filtered = list(t.filter(tool_name="ExitPlanMode"))
    assert filtered == matches


def test_plan_mode_attachment_without_planFilePath_is_not_promoted(tmp_path):
    """A plan_mode_exit attachment with no planFilePath stays as MetaEntry."""
    import json
    sid = "33333333-3333-4333-8333-333333333333"
    line = {
        "type": "attachment",
        "uuid": "00000000-0000-4000-8000-0000000000ff",
        "sessionId": sid,
        "timestamp": "2026-05-21T07:01:00.000Z",
        "attachment": {"type": "plan_mode_exit", "planExists": False},
    }
    jsonl = tmp_path / f"{sid}.jsonl"
    jsonl.write_text(json.dumps(line) + "\n", encoding="utf-8")
    t = AgentTranscriptFile("claude", jsonl)
    assert not [e for e in t.entries if isinstance(e, ExitPlanModeEntry)]
    metas = [e for e in t.entries if isinstance(e, MetaEntry) and e.meta_kind == "attachment"]
    assert len(metas) == 1


def test_multi_block_no_duplicate_entry_ids(claude_multi_block_jsonl):
    """Each Anthropic message.id produces at most one AssistantMessageEntry.

    Locks the contract the viewer depends on: same entry_id appearing on
    multiple AssistantMessageEntry rows = parser fragmentation = downstream
    forced to dedup with brittle heuristics. The parser owns folding.
    """
    t = AgentTranscriptFile("claude", claude_multi_block_jsonl)
    am_ids = [e.entry_id for e in t.entries if isinstance(e, AssistantMessageEntry)]
    assert len(am_ids) == len(set(am_ids)), (
        f"AssistantMessageEntry entry_ids must be unique; got {am_ids}"
    )
