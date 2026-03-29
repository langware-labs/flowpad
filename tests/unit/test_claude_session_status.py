"""Tests for ClaudeSessionFsRecord.status and is_active."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord


# -- status property ----------------------------------------------------------


def _write_jsonl(path, lines):
    """Write JSONL lines to a temp file."""
    path.write_text("\n".join(json.dumps(l) for l in lines))


def test_status_idle_empty_file(tmp_path):
    """Empty JSONL → empty (file exists but no parseable content)."""
    f = tmp_path / "session.jsonl"
    f.write_text("")
    session = ClaudeSessionFsRecord(jsonl_path=str(f))
    assert session.status == "empty"


def test_status_complete_end_turn(tmp_path):
    """Assistant entry with stop_reason=end_turn → complete."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "end_turn", "content": []}},
    ])
    session = ClaudeSessionFsRecord(jsonl_path=str(f))
    assert session.status == "complete"


def test_status_error_stop_sequence(tmp_path):
    """Assistant entry with stop_reason=stop_sequence → error."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "stop_sequence", "content": []}},
    ])
    session = ClaudeSessionFsRecord(jsonl_path=str(f))
    assert session.status == "error"


def test_status_tool_call_active_file(tmp_path):
    """Active file + stop_reason=tool_use → tool_call (Claude dispatched tools)."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": "tool_use", "content": []}},
    ])
    # Keep mtime fresh (active file)
    os.utime(f, None)
    session = ClaudeSessionFsRecord(jsonl_path=str(f))
    assert session.status == "tool_call"


def test_status_thinking_active_no_stop_reason(tmp_path):
    """Active file + assistant with no stop_reason → thinking."""
    f = tmp_path / "session.jsonl"
    _write_jsonl(f, [
        {"type": "user", "message": {"role": "user"}},
        {"type": "assistant", "message": {"role": "assistant", "stop_reason": None, "content": []}},
    ])
    os.utime(f, None)
    session = ClaudeSessionFsRecord(jsonl_path=str(f))
    assert session.status == "thinking"


# -- is_active (now a property backed by PropertyRecord) ---------------------


def test_is_active_recent_file(tmp_path: Path):
    """File modified just now → active."""
    f = tmp_path / "session.jsonl"
    f.write_text("")
    session = ClaudeSessionFsRecord(jsonl_path=str(f))
    assert session.is_active is True


def test_is_active_stale_file(tmp_path: Path):
    """File modified long ago → not active."""
    f = tmp_path / "session.jsonl"
    f.write_text("")
    old_time = time.time() - 600
    os.utime(f, (old_time, old_time))
    session = ClaudeSessionFsRecord(jsonl_path=str(f))
    assert session.is_active is False


def test_is_active_missing_file():
    """No file path → not active."""
    session = ClaudeSessionFsRecord()
    assert session.is_active is False


def test_is_active_nonexistent_path():
    """Path doesn't exist → not active."""
    session = ClaudeSessionFsRecord(jsonl_path="/nonexistent/session.jsonl")
    assert session.is_active is False


# -- from_jsonl captures last_stop_reason -------------------------------------


def test_from_jsonl_captures_last_stop_reason(tmp_path: Path):
    """Multiple assistant entries — last one's stop_reason wins."""
    lines = [
        {"type": "user", "sessionId": "s1", "message": {"role": "user"}},
        {
            "type": "assistant",
            "message": {"role": "assistant", "stop_reason": "tool_use", "content": []},
        },
        {"type": "user", "message": {"role": "user"}},
        {
            "type": "assistant",
            "message": {"role": "assistant", "stop_reason": "end_turn", "content": []},
        },
    ]
    f = tmp_path / "test.jsonl"
    f.write_text("\n".join(json.dumps(l) for l in lines))

    session = ClaudeSessionFsRecord.from_jsonl(f)
    assert session.last_stop_reason == "end_turn"
    assert session.status == "complete"


def test_from_jsonl_no_assistant_entries(tmp_path: Path):
    """Only user entries, active file → waiting (Claude hasn't responded yet)."""
    lines = [
        {"type": "user", "sessionId": "s2", "message": {"role": "user"}},
    ]
    f = tmp_path / "test.jsonl"
    f.write_text("\n".join(json.dumps(l) for l in lines))

    session = ClaudeSessionFsRecord.from_jsonl(f)
    assert session.last_stop_reason is None
    assert session.status == "waiting"


def test_from_jsonl_last_assistant_tool_call(tmp_path: Path):
    """Last assistant has stop_reason=tool_use, active file → tool_call."""
    lines = [
        {"type": "user", "sessionId": "s3", "message": {"role": "user"}},
        {
            "type": "assistant",
            "message": {"role": "assistant", "stop_reason": "end_turn", "content": []},
        },
        {"type": "user", "message": {"role": "user"}},
        {
            "type": "assistant",
            "message": {"role": "assistant", "stop_reason": "tool_use", "content": []},
        },
    ]
    f = tmp_path / "test.jsonl"
    f.write_text("\n".join(json.dumps(l) for l in lines))

    session = ClaudeSessionFsRecord.from_jsonl(f)
    assert session.last_stop_reason == "tool_use"
    assert session.status == "tool_call"
