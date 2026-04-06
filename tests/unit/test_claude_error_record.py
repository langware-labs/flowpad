"""Tests for ClaudeErrorRecord — fingerprinting, record roundtrip, sync_from_debug_logs."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from flow_sdk.fs_records.claude.claude_error import (
    ClaudeErrorRecord,
    ErrorCategory,
    ErrorStatus,
    _fingerprint_hook,
    _fingerprint_log,
    _load_sync_state,
    _normalize,
    sync_from_debug_logs,
    upsert_error,
)
from flow_sdk.fs_store import RecordType
from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

# ─── Normalization ───────────────────────────────────────────────────────────


def test_normalize_strips_uuids():
    text = "Record a1b2c3d4-e5f6-7890-abcd-ef1234567890 not found"
    assert "<UUID>" in _normalize(text)
    assert "a1b2c3d4" not in _normalize(text)


def test_normalize_strips_hex_addresses():
    text = "Object at 0x7f8b12345678"
    assert "<HEX>" in _normalize(text)
    assert "0x7f8b" not in _normalize(text)


def test_normalize_strips_timestamps():
    text = "Error at 2026-02-26T10:11:08.767Z in process"
    assert "<TS>" in _normalize(text)


def test_normalize_strips_paths():
    text = "File /Users/foo/bar/baz.py not found"
    assert "<PATH>" in _normalize(text)


def test_normalize_strips_long_digit_runs():
    text = "Request 12345678 failed"
    assert "<NUM>" in _normalize(text)


# ─── Fingerprinting ──────────────────────────────────────────────────────────


def test_fingerprint_hook_deterministic():
    fp1 = _fingerprint_hook("MyHook", "SessionStart", "ImportError: no module")
    fp2 = _fingerprint_hook("MyHook", "SessionStart", "ImportError: no module")
    assert fp1 == fp2
    assert len(fp1) == 12


def test_fingerprint_hook_same_root_cause_across_hooks():
    """Same root_cause from different hooks should produce the same fingerprint."""
    fp1 = _fingerprint_hook("HookA", "SessionStart", "ImportError: no module")
    fp2 = _fingerprint_hook("HookB", "SessionStart", "ImportError: no module")
    assert fp1 == fp2


def test_fingerprint_hook_different_for_different_root_causes():
    fp1 = _fingerprint_hook("HookA", "SessionStart", "ImportError: no module")
    fp2 = _fingerprint_hook("HookA", "SessionStart", "TypeError: bad type")
    assert fp1 != fp2


def test_fingerprint_hook_ignores_variable_paths():
    fp1 = _fingerprint_hook("MyHook", "E", "File /Users/alice/code/main.py not found")
    fp2 = _fingerprint_hook("MyHook", "E", "File /Users/bob/code/main.py not found")
    assert fp1 == fp2


def test_fingerprint_log_deterministic():
    fp1 = _fingerprint_log("Connection refused to port 9007")
    fp2 = _fingerprint_log("Connection refused to port 9007")
    assert fp1 == fp2
    assert len(fp1) == 12


def test_fingerprint_log_different_for_different_messages():
    fp1 = _fingerprint_log("Connection refused")
    fp2 = _fingerprint_log("File not found")
    assert fp1 != fp2


# ─── Record roundtrip ─────────────────────────────────────────────────────���──


def test_record_type():
    rec = ClaudeErrorRecord()
    assert rec.type == RecordType.CLAUDE_ERROR


def test_record_defaults():
    rec = ClaudeErrorRecord()
    assert rec.error_status == ErrorStatus.OPEN
    assert rec.occurrence_count == 0
    assert rec.occurrences == []
    assert rec.session_ids == []


def test_record_to_dict_roundtrip():
    rec = ClaudeErrorRecord(
        fingerprint="abc123def456",
        error_category=ErrorCategory.HOOK,
        error_msg="ImportError: no module named 'foo'",
        hook="StartupHook",
        event="SessionStart",
        root_cause="ImportError: no module named 'foo'",
        traceback=["Traceback:", "  File ...", "ImportError: no module named 'foo'"],
        occurrence_count=3,
        first_seen="2026-01-01T00:00:00Z",
        last_seen="2026-01-03T00:00:00Z",
        session_ids=["s1", "s2", "s3"],
        last_session_id="s3",
        last_jsonl_path="/path/to/s3.jsonl",
        occurrences=[{"timestamp": "2026-01-01T00:00:00Z", "session_id": "s1"}],
        error_status=ErrorStatus.TASK_CREATED,
        linked_task_id="task-123",
        triaged_at="2026-01-02T00:00:00Z",
    )
    rec.id = "abc123def456"

    d = rec.meta_dict()
    assert d["fingerprint"] == "abc123def456"
    assert d["error_category"] == ErrorCategory.HOOK
    assert d["error_status"] == ErrorStatus.TASK_CREATED
    assert d["occurrence_count"] == 3
    assert len(d["traceback"]) == 3

    # Roundtrip
    loaded = ClaudeErrorRecord.from_dict(d)
    assert loaded.fingerprint == rec.fingerprint
    assert loaded.error_status == rec.error_status
    assert loaded.occurrence_count == 3


def test_record_not_read_only():
    # read_only is FSRef-level; ClaudeErrorRecord has no read_only sentinel so it is writable
    rec = ClaudeErrorRecord()
    assert rec._is_read_only() is False


# ─── sync_from_debug_logs ────────────────────────────────────────────────────

SAMPLE_LOG_WITH_ERRORS = """\
2026-02-26T10:11:08.000Z [DEBUG] Starting session
2026-02-26T10:11:08.767Z [DEBUG] Hook StartupHook (SessionStart) error:
Traceback (most recent call last):
  File "main.py", line 11, in <module>
    from hook_handlers import prompt_submitted
ModuleNotFoundError: No module named 'hook_handlers'
2026-02-26T10:11:08.769Z [DEBUG] Loaded plugins
2026-02-26T10:11:09.000Z [ERROR] MCP server connection refused
"""

SAMPLE_LOG_WITH_SAME_ERROR = """\
2026-02-27T12:00:00.000Z [DEBUG] Starting session
2026-02-27T12:00:01.000Z [DEBUG] Hook StartupHook (SessionStart) error:
Traceback (most recent call last):
  File "main.py", line 11, in <module>
    from hook_handlers import prompt_submitted
ModuleNotFoundError: No module named 'hook_handlers'
2026-02-27T12:00:02.000Z [DEBUG] Done
"""

SAMPLE_CLEAN_LOG = """\
2026-02-26T10:00:00.000Z [DEBUG] Starting session
2026-02-26T10:00:01.000Z [DEBUG] Done
"""


@pytest.fixture
def debug_dir(tmp_path):
    """Create a temp debug directory with sample logs."""
    d = tmp_path / "debug"
    d.mkdir()
    (d / "session-aaa.txt").write_text(SAMPLE_LOG_WITH_ERRORS)
    (d / "session-bbb.txt").write_text(SAMPLE_LOG_WITH_SAME_ERROR)
    (d / "session-ccc.txt").write_text(SAMPLE_CLEAN_LOG)
    return d


@pytest.fixture
def records_dir(tmp_path):
    """Temp records directory for persisted error records."""
    d = tmp_path / "records" / "claude_error"
    d.mkdir(parents=True)
    return d


@pytest.fixture(autouse=True)
def _use_tmp_records_root(tmp_path):
    """Point records_root at tmp_path/records so discover/save use the temp dir."""
    root = tmp_path / "records"
    root.mkdir(exist_ok=True)
    original = get_default_records_root()
    set_default_records_root(root)
    yield
    set_default_records_root(original)


def test_sync_from_debug_logs_creates_records(debug_dir, records_dir, monkeypatch):
    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_error.ClaudeSessionDebugLogRecord.debug_dir",
        classmethod(lambda cls: debug_dir),
    )
    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_error._find_transcript",
        lambda sid: f"/fake/projects/test/{sid}.jsonl",
    )

    sync_from_debug_logs(records_dir, hours=9999)
    records = ClaudeErrorRecord.discover()

    # session-aaa: 1 hook error + 1 log error = 2 fingerprints
    # session-bbb: 1 hook error (same fingerprint as aaa's hook error)
    # session-ccc: no errors
    # -> 2 unique fingerprints
    assert len(records) == 2

    hook_rec = next(r for r in records if r.error_category == ErrorCategory.HOOK)
    assert hook_rec.hook == "StartupHook"
    assert hook_rec.event == "SessionStart"
    assert "ModuleNotFoundError" in hook_rec.root_cause
    assert hook_rec.occurrence_count == 2
    assert len(hook_rec.session_ids) == 2
    assert hook_rec.error_status == ErrorStatus.OPEN

    log_rec = next(r for r in records if r.error_category == ErrorCategory.LOG)
    assert "MCP server connection refused" in log_rec.error_msg
    assert log_rec.occurrence_count == 1


def test_sync_from_debug_logs_idempotent(debug_dir, records_dir, monkeypatch):
    """Running sync twice produces the same records (no double-counting)."""
    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_error.ClaudeSessionDebugLogRecord.debug_dir",
        classmethod(lambda cls: debug_dir),
    )
    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_error._find_transcript",
        lambda sid: f"/fake/projects/test/{sid}.jsonl",
    )

    sync_from_debug_logs(records_dir, hours=9999)
    records1 = ClaudeErrorRecord.discover()
    hook_count_1 = next(r for r in records1 if r.error_category == ErrorCategory.HOOK).occurrence_count

    sync_from_debug_logs(records_dir, hours=9999)
    records2 = ClaudeErrorRecord.discover()
    hook_count_2 = next(r for r in records2 if r.error_category == ErrorCategory.HOOK).occurrence_count

    assert len(records1) == len(records2)
    assert hook_count_1 == hook_count_2


def test_sync_from_debug_logs_detects_new_file(debug_dir, records_dir, monkeypatch):
    """Adding a new debug log file picks it up on next sync."""
    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_error.ClaudeSessionDebugLogRecord.debug_dir",
        classmethod(lambda cls: debug_dir),
    )
    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_error._find_transcript",
        lambda sid: f"/fake/projects/test/{sid}.jsonl",
    )

    sync_from_debug_logs(records_dir, hours=9999)

    # Write a new file with a new unique error
    (debug_dir / "session-ddd.txt").write_text("2026-02-28T00:00:00.000Z [ERROR] Brand new error\n")

    sync_from_debug_logs(records_dir, hours=9999)
    records = ClaudeErrorRecord.discover()
    assert len(records) == 3


def test_sync_state_saved(debug_dir, records_dir, monkeypatch):
    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_error.ClaudeSessionDebugLogRecord.debug_dir",
        classmethod(lambda cls: debug_dir),
    )
    monkeypatch.setattr(
        "flow_sdk.fs_records.claude.claude_error._find_transcript",
        lambda sid: f"/fake/projects/test/{sid}.jsonl",
    )

    sync_from_debug_logs(records_dir, hours=9999)
    state = _load_sync_state(records_dir)
    assert "session-aaa" in state["processed"]
    assert "session-bbb" in state["processed"]
    assert "session-ccc" in state["processed"]


def test_upsert_error_creates_new_record(tmp_path):
    """upsert_error creates a new ClaudeErrorRecord when fingerprint not present."""
    upsert_error(
        fingerprint="abc123def456",
        error_category=ErrorCategory.HOOK,
        error_msg="some error",
        hook="MyHook",
        event="SessionStart",
        root_cause="some error",
        traceback=["line1"],
        timestamp="2026-01-01T00:00:00Z",
        session_id="sess-1",
        jsonl_path="",
    )

    rec = ClaudeErrorRecord.get_by_fingerprint("abc123def456")
    assert rec is not None
    assert rec.error_category == ErrorCategory.HOOK
    assert rec.occurrence_count == 1


def test_upsert_error_merges_existing(tmp_path):
    """upsert_error increments occurrence_count for existing fingerprint."""
    for ts in ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"]:
        upsert_error(
            fingerprint="aabbccddeeff",
            error_category=ErrorCategory.LOG,
            error_msg="log error",
            hook="",
            event="",
            root_cause="",
            traceback=[],
            timestamp=ts,
            session_id=f"sess-{ts}",
            jsonl_path="",
        )

    rec = ClaudeErrorRecord.get_by_fingerprint("aabbccddeeff")
    assert rec is not None
    assert rec.occurrence_count == 2
