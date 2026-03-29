"""Tests for ShellRecord lifecycle methods (close, pty_stream_path)."""

import pytest

from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus
from flow_sdk.fs_store.record import get_default_records_root, record_stem, set_default_records_root


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    """Set records root to tmp_path for all tests."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def _make_record(**kwargs):
    """Create and save a ShellRecord with defaults."""
    defaults = {
        "id": "test-session-1",
        "pty_pid": "pty-abc",
        "workdir": "/tmp",
        "name": "test-shell",
        "state": ShellStatus.RUNNING,
    }
    defaults.update(kwargs)
    record = ShellRecord(**defaults)
    record.save()
    return record


def test_status():
    record = _make_record()
    assert record.status == ShellStatus.RUNNING
    assert record.data.get("pty_pid") == "pty-abc"
    assert record.data.get("workdir") == "/tmp"


def test_status_delegates_to_data():
    record = _make_record(state=ShellStatus.IDLE)
    assert record.status == ShellStatus.IDLE
    record.status = ShellStatus.RUNNING
    assert record.status == ShellStatus.RUNNING


def test_close_sets_status_and_deletes_pty(use_tmp_records_root):
    record = _make_record()

    pty_path = record.pty_stream_path
    pty_path.parent.mkdir(parents=True, exist_ok=True)
    pty_path.write_bytes(b"some pty data")
    assert pty_path.exists()

    record.close()

    assert record.status == ShellStatus.CLOSED
    assert not pty_path.exists()

    reloaded = ShellRecord.discover_one("test-session-1")
    assert reloaded is not None
    assert reloaded.status == ShellStatus.CLOSED


def test_close_idempotent():
    record = _make_record(state=ShellStatus.CLOSED)
    record.close()
    assert record.status == ShellStatus.CLOSED


def test_pty_stream_path(use_tmp_records_root):
    record = _make_record(id="sess-42", pty_pid="pty-xyz")
    expected = use_tmp_records_root / "shell" / record_stem("shell", "sess-42") / "pty-xyz.pty"
    assert record.pty_stream_path == expected


def test_pty_stream_path_raises_without_pty_pid():
    record = _make_record(pty_pid=None)
    with pytest.raises(ValueError, match="No pty_pid set"):
        _ = record.pty_stream_path


