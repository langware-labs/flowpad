"""CodexSessionRecord tests — lazy stats, from_jsonl, discover, get."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_records.codex import CodexSessionRecord
from flow_sdk.fs_records.codex.codex_session import _extract_thread_id
from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.fs_ref import FSRef


# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)


def test_thread_id_extraction():
    assert (
        _extract_thread_id(
            "rollout-2026-03-11T17-02-01-019cdd6b-49a7-7480-9da1-6a724db3d747.jsonl"
        )
        == "019cdd6b-49a7-7480-9da1-6a724db3d747"
    )
    assert _extract_thread_id("not-a-rollout.jsonl") is None


def test_record_type_and_indexing():
    assert CodexSessionRecord._record_type == RecordType.CODEX_SESSION
    assert CodexSessionRecord._indexed_by_default is True


def test_from_jsonl_rollout_envelope(codex_sandbox: Path):
    rollout = next((codex_sandbox / "sessions").rglob("rollout-*aaaaaaaaaaaa.jsonl"))
    rec = CodexSessionRecord.from_jsonl(rollout)

    assert rec.session_id == "019cdd6b-49a7-7480-9da1-aaaaaaaaaaaa"
    assert rec.id == rec.session_id
    assert rec.cwd == "/repo"
    assert rec.version == "0.101.0"
    assert rec.originator == "codex_cli_rs"
    assert rec.worker_type == "codex"


def test_from_jsonl_reads_long_session_meta_line(tmp_path: Path):
    session_id = "019cdd6b-49a7-7480-9da1-cccccccccccc"
    rollout = tmp_path / f"rollout-2026-03-11T17-02-01-{session_id}.jsonl"
    lines = [
        {
            "type": "session_meta",
            "payload": {
                "id": session_id,
                "cwd": "/Users/test/worktree",
                "cli_version": "0.101.0",
                "originator": "codex_cli_rs",
                "base_instructions": "x" * 20000,
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "restore this session"}],
            },
        },
    ]
    rollout.write_text("\n".join(json.dumps(line) for line in lines), encoding="utf-8")

    rec = CodexSessionRecord.from_jsonl(rollout)

    assert CodexSessionRecord.getId(FSRef(rollout)) == session_id
    assert rec.session_id == session_id
    assert rec.cwd == "/Users/test/worktree"
    assert rec.version == "0.101.0"
    assert rec.last_user_message == "restore this session"


def test_from_jsonl_lazy_stats(codex_sandbox: Path):
    rollout = next((codex_sandbox / "sessions").rglob("rollout-*aaaaaaaaaaaa.jsonl"))
    rec = CodexSessionRecord.from_jsonl(rollout)

    # First access of any lazy-stats field triggers the JSONL parse.
    assert rec.message_count == 2
    assert rec.user_message_count == 1
    assert rec.assistant_message_count == 1
    assert rec.model == "gpt-5.3-codex"
    assert rec.effort == "xhigh"
    assert rec.personality == "pragmatic"
    assert rec.approval_policy == "on-request"
    assert rec.sandbox_policy == "workspace-write"
    assert rec.git_branch == "main"
    assert rec.last_user_message == "Add a small helper function that prints hello."
    assert rec.estimated_cost_usd == 0.0
    assert rec.primary_model == "gpt-5.3-codex"


def test_from_jsonl_stream_event_shape(
    tmp_path: Path,
    codex_stream_src: str,
):
    p = tmp_path / "rollout-2026-03-11T15-02-01-019dddd0-1234-7000-9000-000000000001.jsonl"
    p.write_text(codex_stream_src)
    rec = CodexSessionRecord.from_jsonl(p)

    assert rec.session_id == "019dddd0-1234-7000-9000-000000000001"
    # Stream-event shape: 1 agent_message + 2 tool events (command + file_change).
    assert rec.assistant_message_count == 1
    assert rec.tool_uses == 2
    # turn.completed `usage` block is summed.
    assert rec.input_tokens == 1234
    assert rec.output_tokens == 56


def test_discover_walks_sessions_tree(codex_sandbox: Path):
    sessions = CodexSessionRecord.discover()
    cwds = sorted(s.cwd for s in sessions)
    assert cwds == ["/Users/test/proj_b", "/repo"]


def test_discover_limit(codex_sandbox: Path):
    sessions = CodexSessionRecord.discover(limit=1)
    assert len(sessions) == 1


def test_get_by_thread_id(codex_sandbox: Path):
    rec = CodexSessionRecord.get("019cdd99-49a7-7480-9da1-bbbbbbbbbbbb")
    assert rec is not None
    assert rec.cwd == "/Users/test/proj_b"


def test_get_unknown_returns_none(codex_sandbox: Path):
    assert CodexSessionRecord.get("00000000-0000-0000-0000-000000000000") is None


def test_search_title_uses_last_user_message(codex_sandbox: Path):
    rollout = next((codex_sandbox / "sessions").rglob("rollout-*aaaaaaaaaaaa.jsonl"))
    rec = CodexSessionRecord.from_jsonl(rollout)
    assert rec.search_title == "Add a small helper function that prints hello."
