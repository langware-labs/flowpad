"""SessionReader conformance — Claude and Codex transcript stats (spec §8).

The two existing folds are the oracle: a value is their dict, minus the two
keys the wrapper owns for Claude (``task_path``, ``estimated_cost_usd``).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.diskio.contract import SessionReader
from flow_sdk.fs_store.indexer.functions._claude_session_stats import _parse_jsonl_stats
from flow_sdk.fs_store.indexer.functions._codex_session_stats import _parse_codex_jsonl_stats
from tests.unit.diskio._backends import backends, drain


@pytest.fixture(params=backends(SessionReader))
def reader(request):
    return request.param()


def jsonl(path: Path, lines: list) -> Path:
    path.write_text("".join((line if isinstance(line, str) else json.dumps(line)) + "\n" for line in lines),
                    encoding="utf-8")
    return path


CLAUDE = [
    {"type": "user", "timestamp": "2026-01-02T03:04:05Z", "sessionId": "sess-1", "cwd": "/work/app",
     "version": "2.1.0", "gitBranch": "main", "slug": "fix-the-bug",
     "message": {"content": "  please fix the bug  "}},
    "{this line is not json",
    "",
    {"type": "user", "message": {"content": [{"type": "text", "text": "<system-reminder>skip</system-reminder>"}]}},
    {"type": "assistant", "message": {
        "model": "claude-sonnet-4-5", "stop_reason": "tool_use",
        "usage": {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 7,
                  "cache_creation_input_tokens": 3},
        "content": [{"type": "tool_use", "name": "Read"}, {"type": "tool_use", "name": "Bash"},
                    {"type": "text", "text": "Looking at it."}]}},
    {"type": "assistant", "message": {
        "model": "claude-sonnet-4-5", "stop_reason": "end_turn",
        "usage": {"input_tokens": 50, "output_tokens": 10}, "content": [{"type": "text", "text": "Done."}]}},
    {"type": "system", "subtype": "turn_duration", "durationMs": 1500},
    {"type": "user", "planContent": "the plan", "message": {"content": "second ask"}},
]

CODEX = [
    {"type": "session_meta", "timestamp": "2026-02-03T04:05:06Z",
     "payload": {"id": "codex-1", "cwd": "/work/app", "cli_version": "0.50.0", "originator": "codex_cli",
                 "git": {"branch": "dev"}}},
    "not json at all",
    {"type": "turn_context", "payload": {"model": "gpt-5-codex", "effort": "high", "personality": "terse",
                                          "approval_policy": "on-request", "sandbox_policy": {"type": "workspace-write"}}},
    {"type": "response_item", "payload": {"type": "message", "role": "user",
                                           "content": [{"type": "input_text", "text": "<prelude/>"},
                                                       {"type": "input_text", "text": "add a test"}]}},
    {"type": "response_item", "payload": {"type": "message", "role": "assistant",
                                           "content": [{"type": "output_text", "text": "Added."}]}},
    {"type": "response_item", "payload": {"type": "function_call", "name": "shell"}},
    {"type": "token_count", "payload": {"info": {"last_token_usage": {
        "input_tokens": 40, "output_tokens": 9, "cached_input_tokens": 4}}}},
    {"type": "event_msg", "payload": {"type": "turn.completed", "reason": "stop"}},
    {"type": "item.completed", "item": {"type": "command_execution"}},
    {"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 2}},
]


def same_as_fold(value, fold: dict, *, wrapper_keys: tuple[str, ...] = ()) -> None:
    dumped = value.model_dump()
    assert dumped.pop("error") is None
    dumped.pop("path")
    expected = {key: tuple(item) if isinstance(item, list) else item
                for key, item in fold.items() if key not in wrapper_keys}
    assert dumped == expected


def test_claude_stats(reader, tmp_path):
    path = jsonl(tmp_path / "file-stem.jsonl", CLAUDE)
    body, end = drain(reader.claude([str(path)]))
    assert end.counts == {"diskio.session_stats.claude": 1}
    (stats,) = body
    assert stats.path == str(path) and stats.error is None
    assert (stats.session_id, stats.cwd, stats.version, stats.git_branch, stats.slug) == (
        "sess-1", "/work/app", "2.1.0", "main", "fix-the-bug")
    assert (stats.message_count, stats.user_message_count, stats.assistant_message_count) == (5, 3, 2)
    assert (stats.input_tokens, stats.output_tokens) == (150, 30)
    assert (stats.cache_read_input_tokens, stats.cache_creation_input_tokens) == (7, 3)
    assert stats.duration_ms == 1500 and stats.has_plan is True
    assert stats.tools_used == ("Bash", "Read")
    assert (stats.model, stats.primary_model, stats.models_used) == (
        "claude-sonnet-4-5", "claude-sonnet-4-5", ("claude-sonnet-4-5",))
    assert stats.last_stop_reason == "end_turn" and stats.last_user_message == "second ask"
    assert stats.created_at == "2026-01-02T03:04:05Z" and stats.modified_at is not None
    assert stats.search_content.splitlines() == [
        "fix-the-bug", "/work/app", "user: please fix the bug",
        "assistant: Looking at it.", "assistant: Done.", "user: second ask",
    ]
    same_as_fold(stats, _parse_jsonl_stats(path), wrapper_keys=("task_path", "estimated_cost_usd"))


def test_codex_stats(reader, tmp_path):
    path = jsonl(tmp_path / "rollout-1.jsonl", CODEX)
    body, end = drain(reader.codex([str(path)]))
    assert end.counts == {"diskio.session_stats.codex": 1}
    (stats,) = body
    assert stats.error is None and stats.worker_type == "codex" and stats.estimated_cost_usd == 0.0
    assert (stats.session_id, stats.cwd, stats.version, stats.originator, stats.git_branch) == (
        "codex-1", "/work/app", "0.50.0", "codex_cli", "dev")
    assert (stats.model, stats.effort, stats.personality) == ("gpt-5-codex", "high", "terse")
    assert (stats.approval_policy, stats.sandbox_policy) == ("on-request", "workspace-write")
    assert (stats.message_count, stats.user_message_count, stats.assistant_message_count) == (2, 1, 1)
    assert stats.tool_uses == 2
    assert (stats.input_tokens, stats.output_tokens, stats.cache_read_input_tokens) == (41, 11, 4)
    assert (stats.last_user_message, stats.last_assistant_message) == ("add a test", "Added.")
    assert stats.last_stop_reason == "stop" and stats.created_at == "2026-02-03T04:05:06Z"
    assert stats.models_used == ("gpt-5-codex",) and stats.primary_model == "gpt-5-codex"
    same_as_fold(stats, _parse_codex_jsonl_stats(path))


def test_a_malformed_line_is_skipped(reader, tmp_path):
    lines = [{"type": "user", "message": {"content": "hello"}}, '{"type": "user", "message": ', "}}}"]
    (claude,) = drain(reader.claude([str(jsonl(tmp_path / "c.jsonl", lines))]))[0]
    assert claude.error is None and claude.user_message_count == 1
    codex_lines = [CODEX[3], "{broken", CODEX[4]]
    (codex,) = drain(reader.codex([str(jsonl(tmp_path / "x.jsonl", codex_lines))]))[0]
    assert codex.error is None and codex.message_count == 2


def test_an_empty_transcript_is_zeros_and_no_error(reader, tmp_path):
    path = jsonl(tmp_path / "empty.jsonl", [])
    (claude,) = drain(reader.claude([str(path)]))[0]
    assert claude.error is None and claude.message_count == 0 and claude.session_id == "empty"
    assert claude.search_content is None and claude.primary_model is None
    (codex,) = drain(reader.codex([str(path)]))[0]
    assert codex.error is None and codex.session_id == "empty" and codex.models_used == ()


def test_a_missing_file_is_an_unreadable_item_not_an_exception(reader, tmp_path):
    good = jsonl(tmp_path / "good.jsonl", CLAUDE)
    missing = tmp_path / "missing.jsonl"
    body, end = drain(reader.claude([str(missing), str(good)]))
    assert end.counts == {"diskio.session_stats.claude": 2}
    by_path = {stats.path: stats for stats in body}
    assert (by_path[str(missing)].error.kind, by_path[str(missing)].error.detail) == ("unreadable", "ENOENT")
    assert by_path[str(missing)].message_count == 0 and by_path[str(missing)].modified_at is None
    assert by_path[str(good)].error is None
    (codex,) = drain(reader.codex([str(missing)]))[0]
    assert codex.error.kind == "unreadable"


def test_bytes_that_are_not_utf8_are_a_decode_item_not_an_exception(reader, tmp_path):
    path = tmp_path / "bad.jsonl"
    path.write_bytes(b'{"type": "user", "message": {"content": "ok"}}\n\xff\xfe\n')
    (claude,) = drain(reader.claude([str(path)]))[0]
    assert claude.error.kind == "decode" and claude.path == str(path)
    (codex,) = drain(reader.codex([str(path)]))[0]
    assert codex.error.kind == "decode"


def test_an_empty_batch_is_only_the_terminal(reader):
    assert drain(reader.claude([])) == ([], drain(reader.codex([]))[1])
