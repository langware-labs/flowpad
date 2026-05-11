"""Claude parser dispatch + ExitPlanMode extraction."""

from __future__ import annotations

import warnings

import pytest

from flow_sdk.transcript_analyzer import (
    AgentTranscript,
    AssistantMessageEntry,
    EntryKind,
    ExitPlanModeEntry,
    MetaEntry,
    ShellCommandEntry,
    SystemEntry,
    UnknownEntry,
    UserMessageEntry,
)


def test_parses_all_lines_with_one_warning_for_unknown(claude_jsonl):
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        t = AgentTranscript("claude", claude_jsonl)
    # 12 raw lines; Bash is parsed as shell_command and its tool_result is
    # folded into that operation. Each assistant turn (assistant_message + 2
    # tool_use) also emits a synthetic TokenUsageEntry → 12 - 1 + 3 = 14.
    assert len(t) == 14
    # One synthetic unknown line at the end → exactly one warning.
    unknown_warnings = [w for w in caught if "unknown entry type" in str(w.message)]
    assert len(unknown_warnings) == 1
    assert "totally-novel-type-future-claude" in str(unknown_warnings[0].message)


def test_session_id_propagates_from_first_line(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
    assert t.session_id == "11111111-1111-4111-8111-111111111111"
    # Every entry that carries sessionId in its raw line should have it.
    for e in t.entries:
        if e.kind is not EntryKind.UNKNOWN:
            assert e.session_id == "11111111-1111-4111-8111-111111111111"


def test_entry_kind_breakdown(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
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
    # Each assistant turn (assistant_message + 2 tool_use) carries usage
    # data that the parser splits out as a separate TokenUsageEntry → 3 token_usage.
    assert counts == {
            "meta": 5,
            "user_message": 1,
            "assistant_message": 1,
            "tool_use": 1,
            "shell_command": 1,
            "system": 1,
            "unknown": 1,
            "token_usage": 3,
    }


def test_latest_tool_use_resolves_exit_plan_mode(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
    plan = t.latest_tool_use("ExitPlanMode")
    assert plan is not None
    assert isinstance(plan, ExitPlanModeEntry)
    assert plan.plan_file_path == "/Users/sample/.claude/plans/sample-plan-name.md"
    assert plan.plan_text.startswith("# Sample plan")
    assert plan.tool_use_id == "toolu_sample_plan_001"


def test_latest_tool_use_for_unknown_tool_returns_none(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
    assert t.latest_tool_use("DoesNotExist") is None


def test_unknown_entry_carries_raw_data(claude_jsonl):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t = AgentTranscript("claude", claude_jsonl)
    unknowns = [e for e in t.entries if isinstance(e, UnknownEntry)]
    assert len(unknowns) == 1
    raw = unknowns[0].raw_data
    assert raw is not None
    assert raw.get("type") == "totally-novel-type-future-claude"
    assert raw.get("weirdField") == "value"


def test_known_entries_have_raw_data_none(claude_jsonl):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        t = AgentTranscript("claude", claude_jsonl)
    # All non-UnknownEntry entries should have raw_data is None per the
    # design (parsers extract what they need at parse time).
    for e in t.entries:
        if isinstance(e, UnknownEntry):
            continue
        assert e.raw_data is None, f"{type(e).__name__} unexpectedly carries raw_data"


def test_filter_by_kind(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
    assistants = list(t.filter(kind=EntryKind.ASSISTANT_MESSAGE))
    assert all(isinstance(e, AssistantMessageEntry) for e in assistants)
    assert len(assistants) == 1


def test_filter_by_tool_name(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
    bashes = list(t.filter(tool_name="Bash"))
    assert len(bashes) == 1
    assert isinstance(bashes[0], ShellCommandEntry)
    assert bashes[0].tool_name == "Bash"
    assert bashes[0].command == "echo ok"


def test_shell_command_folds_tool_result_fields(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
    commands = [e for e in t.entries if isinstance(e, ShellCommandEntry)]
    assert len(commands) == 1
    cmd = commands[0]
    assert cmd.tool_use_id == "toolu_sample_bash_001"
    assert "ok" in (cmd.stdout_preview or "")


def test_user_message_entry_fields(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
    users = [e for e in t.entries if isinstance(e, UserMessageEntry)]
    assert len(users) == 1
    assert users[0].text  # non-empty after sanitization


def test_meta_kind_propagation(claude_jsonl):
    t = AgentTranscript("claude", claude_jsonl)
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
    t = AgentTranscript("claude", claude_jsonl)
    systems = [e for e in t.entries if isinstance(e, SystemEntry)]
    assert len(systems) == 1
    assert systems[0].subtype == "stop_hook_summary"
