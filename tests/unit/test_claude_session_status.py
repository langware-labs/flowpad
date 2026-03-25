"""Tests for ClaudeSessionFsRecord.status and is_active."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord


# -- status property ----------------------------------------------------------


def test_status_idle_no_assistant():
    """No assistant messages → idle."""
    session = ClaudeSessionFsRecord(assistant_message_count=0)
    assert session.status == "idle"


def test_status_complete_end_turn():
    session = ClaudeSessionFsRecord(
        assistant_message_count=1,
        last_stop_reason="end_turn",
    )
    assert session.status == "complete"


def test_status_complete_stop_sequence():
    session = ClaudeSessionFsRecord(
        assistant_message_count=1,
        last_stop_reason="stop_sequence",
    )
    assert session.status == "complete"


def test_status_running_tool_use():
    session = ClaudeSessionFsRecord(
        assistant_message_count=1,
        last_stop_reason="tool_use",
    )
    assert session.status == "running"


def test_status_running_none():
    """Assistant messages exist but last_stop_reason is None → running."""
    session = ClaudeSessionFsRecord(
        assistant_message_count=1,
        last_stop_reason=None,
    )
    assert session.status == "running"


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
    """Only user entries → idle status, no stop_reason."""
    lines = [
        {"type": "user", "sessionId": "s2", "message": {"role": "user"}},
    ]
    f = tmp_path / "test.jsonl"
    f.write_text("\n".join(json.dumps(l) for l in lines))

    session = ClaudeSessionFsRecord.from_jsonl(f)
    assert session.last_stop_reason is None
    assert session.status == "idle"


def test_from_jsonl_last_assistant_running(tmp_path: Path):
    """Last assistant has stop_reason=tool_use → running."""
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
    assert session.status == "running"
