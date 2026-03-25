"""Tests for claude_debug_log records via the fs-records action."""

import json
import pytest
from pathlib import Path

from flow_sdk.fs_records.claude.claude_debug_log import (
    ClaudeSessionDebugLogRecord,
    ClaudeSessionDebugLogRecordList,
    HookError,
    parse_hook_errors,
    has_hook_errors,
)

# Backward-compat aliases used in this file
ClaudeDebugLogFsRecord = ClaudeSessionDebugLogRecord
ClaudeDebugLogRecordList = ClaudeSessionDebugLogRecordList


# ─── Unit tests for the parser ───────────────────────────────────────────────


SAMPLE_LOG = """\
2026-02-26T10:11:08.000Z [DEBUG] Starting session
2026-02-26T10:11:08.100Z [DEBUG] Loading plugins
2026-02-26T10:11:08.767Z [DEBUG] Hook SessionStart:startup (SessionStart) error:
Traceback (most recent call last):
  File "main.py", line 11, in <module>
    from hook_handlers import prompt_submitted
  File "hook_handlers/prompt_submitted.py", line 6, in <module>
    from flow_sdk.discovery import discover
ModuleNotFoundError: No module named 'flow_sdk'
2026-02-26T10:11:08.769Z [DEBUG] Loaded plugins
2026-02-26T10:11:36.946Z [DEBUG] Hook UserPromptSubmit (UserPromptSubmit) error:
TypeError: 'NoneType' object is not callable
2026-02-26T10:11:37.086Z [DEBUG] Next event
"""


@pytest.fixture
def debug_dir(tmp_path):
    """Create a temp debug directory with a sample log."""
    d = tmp_path / "debug"
    d.mkdir()
    log_file = d / "test-session-123.txt"
    log_file.write_text(SAMPLE_LOG)
    # Also create a clean log with no errors
    clean = d / "clean-session-456.txt"
    clean.write_text(
        "2026-02-26T10:00:00.000Z [DEBUG] Starting session\n"
        "2026-02-26T10:00:01.000Z [DEBUG] Done\n"
    )
    return d


def test_parse_hook_errors(debug_dir):
    errors = parse_hook_errors(debug_dir / "test-session-123.txt")
    assert len(errors) == 2

    e1 = errors[0]
    assert e1.hook == "SessionStart:startup"
    assert e1.event == "SessionStart"
    assert e1.timestamp == "2026-02-26T10:11:08.767Z"
    assert e1.root_cause == "ModuleNotFoundError: No module named 'flow_sdk'"
    assert len(e1.traceback) == 6
    assert "Traceback" in e1.traceback[0]
    assert "ModuleNotFoundError" in e1.traceback[-1]

    e2 = errors[1]
    assert e2.hook == "UserPromptSubmit"
    assert e2.event == "UserPromptSubmit"
    assert e2.root_cause == "TypeError: 'NoneType' object is not callable"
    assert len(e2.traceback) == 1


def test_parse_empty_log(debug_dir):
    errors = parse_hook_errors(debug_dir / "clean-session-456.txt")
    assert errors == []


def test_has_hook_errors(debug_dir):
    assert has_hook_errors(debug_dir / "test-session-123.txt") is True
    assert has_hook_errors(debug_dir / "clean-session-456.txt") is False


def test_hook_error_to_dict():
    e = HookError(
        hook="PreToolUse:Read",
        event="PreToolUse",
        timestamp="2026-01-01T00:00:00.000Z",
        traceback=["line1", "line2"],
        root_cause="ImportError: no module",
    )
    d = e.to_dict()
    assert d["hook"] == "PreToolUse:Read"
    assert d["traceback"] == ["line1", "line2"]
    assert d["root_cause"] == "ImportError: no module"


# ─── Record tests ────────────────────────────────────────────────────────────


def test_record_from_debug_file(debug_dir):
    rec = ClaudeDebugLogFsRecord.from_debug_file(debug_dir / "test-session-123.txt")
    assert rec.session_id == "test-session-123"
    assert rec.id == "test-session-123"
    assert rec.type == "claude_debug_log"
    assert rec.has_errors is True
    assert rec.error_count == 2
    assert len(rec.hook_errors) == 2
    assert rec.hook_errors[0]["hook"] == "SessionStart:startup"


def test_record_to_dict(debug_dir):
    rec = ClaudeDebugLogFsRecord.from_debug_file(debug_dir / "test-session-123.txt")
    d = rec.meta_dict()
    assert d["id"] == "test-session-123"
    assert d["type"] == "claude_debug_log"
    assert d["has_errors"] is True
    assert d["error_count"] == 2
    assert isinstance(d["hook_errors"], list)
    assert d["hook_errors"][0]["event"] == "SessionStart"


def test_record_read_only(debug_dir):
    rec = ClaudeDebugLogFsRecord()
    assert rec._is_read_only() is True


# ─── Record list tests ───────────────────────────────────────────────────────


def test_record_list_iteration(debug_dir):
    rl = ClaudeDebugLogRecordList(list_path=debug_dir, hours=9999)
    records = list(rl)
    # Only the file with errors should appear
    assert len(records) == 1
    assert records[0].session_id == "test-session-123"


def test_record_list_get(debug_dir):
    rl = ClaudeDebugLogRecordList(list_path=debug_dir, hours=9999)
    rec = rl.get("test-session-123")
    assert rec is not None
    assert rec.error_count == 2

    assert rl.get("nonexistent") is None


def test_record_list_len(debug_dir):
    rl = ClaudeDebugLogRecordList(list_path=debug_dir, hours=9999)
    assert len(rl) == 1


# ─── API integration test ────────────────────────────────────────────────────


def _compute_node_id(bootstrap_payload: dict) -> str:
    return bootstrap_payload["data"]["default_compute_node"]["id"]


@pytest.mark.asyncio
async def test_fs_records_list_type_includes_debug_log(bootstrapped_client):
    """The claude_debug_log type should appear in the types list."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(f"/api/v1/graph/compute_node/{cn_id}/fs-records")
    assert resp.status_code == 200
    body = resp.json()
    assert "claude_debug_log" in body["data"]["types"]




@pytest.mark.asyncio
async def test_fs_records_get_nonexistent_debug_log(bootstrapped_client):
    """GET /fs-records/claude_debug_log/nonexistent should 404."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.get(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_debug_log/nonexistent"
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_fs_records_write_debug_log_rejected(bootstrapped_client):
    """POST to a read-only type should be rejected."""
    bootstrap = await bootstrapped_client.get("/api/v1/graph/bootstrap")
    cn_id = _compute_node_id(bootstrap.json())

    resp = await bootstrapped_client.post(
        f"/api/v1/graph/compute_node/{cn_id}/fs-records/claude_debug_log",
        json={"name": "test"},
    )
    assert resp.status_code == 403
