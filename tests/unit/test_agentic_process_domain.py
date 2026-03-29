"""Tests for AgenticProcess domain class."""

from unittest.mock import patch

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.fs_records.agentic_process_record import AgenticProcessRecord, AgenticProcessStatus


def test_fromRecord():
    record = AgenticProcessRecord(name="test-proc", worker_session_id="ws-1")
    proc = AgenticProcess.fromRecord(record)
    assert proc.id == record.id
    assert proc.name == "test-proc"
    assert isinstance(proc, AgenticProcess)


def test_status_delegates_to_record():
    record = AgenticProcessRecord(name="test-proc", worker_session_id="ws-1")
    proc = AgenticProcess.fromRecord(record)
    with patch.object(AgenticProcessRecord, "discover_status", return_value=AgenticProcessStatus.RUNNING):
        assert proc.status == AgenticProcessStatus.RUNNING


def test_on_and_emit():
    record = AgenticProcessRecord(name="test-proc")
    proc = AgenticProcess.fromRecord(record)
    called = []
    proc.on("complete", lambda: called.append("complete"))
    proc._emit("complete")
    assert called == ["complete"]


def test_on_unsubscribe():
    record = AgenticProcessRecord(name="test-proc")
    proc = AgenticProcess.fromRecord(record)
    called = []
    unsub = proc.on("complete", lambda: called.append("complete"))
    unsub()
    proc._emit("complete")
    assert called == []
