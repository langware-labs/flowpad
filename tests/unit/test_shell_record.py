"""Unit tests for ShellRecord."""

from unittest import mock

import pytest

from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus
from flow_sdk.fs_store import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def test_create_with_defaults():
    record = ShellRecord()
    assert record.status == ShellStatus.IDLE
    # pty_pid defaults to the record's id (same UUID)
    assert record.data.get("pty_pid") == record.id
    assert record.data.get("tab_order") == 0


def test_create_with_kwargs():
    record = ShellRecord(pty_pid="abc", workdir="/tmp", name="test")
    assert record.data.get("pty_pid") == "abc"
    assert record.data.get("workdir") == "/tmp"
    assert record.name == "test"


def test_status_property():
    record = ShellRecord(state=ShellStatus.RUNNING)
    assert record.status == ShellStatus.RUNNING


def test_touch_updates_last_active_at():
    record = ShellRecord(id="touch-test")
    record.save()
    original_time = record.data.get("last_active_at")
    with mock.patch("flow_sdk.fs_records.shell_record.datetime") as mock_dt:
        mock_dt.now.return_value.isoformat.return_value = "2099-01-01T00:00:00+00:00"
        mock_dt.side_effect = lambda *a, **kw: mock_dt
        record.touch()
    assert record.data.get("last_active_at") == "2099-01-01T00:00:00+00:00"
    assert record.data.get("last_active_at") != original_time


def test_save_and_discover():
    record = ShellRecord(id="discover-test", name="my-session")
    record.save()
    found = ShellRecord.discover()
    assert len(found) >= 1
    ids = [r.id for r in found]
    assert "discover-test" in ids


def test_get():
    record = ShellRecord(id="one-test", name="unique")
    record.save()
    found = ShellRecord.get("one-test")
    assert found is not None
    assert found.id == "one-test"
    assert found.name == "unique"


def test_status_transitions():
    record = ShellRecord(id="transition-test")
    assert record.status == ShellStatus.IDLE

    record.status = ShellStatus.RUNNING
    assert record.status == ShellStatus.RUNNING

    record.status = ShellStatus.CLOSED
    assert record.status == ShellStatus.CLOSED


def test_claude_session_id_field():
    record = ShellRecord(claude_session_id="x")
    assert record.data.get("claude_session_id") == "x"
