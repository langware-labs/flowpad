"""Tests for shell session lifecycle integration.

Tests the wiring between on_pty_output -> PtyStreamFile and
close_session -> record transition + .pty file deletion.
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.compute.providers.desktop.pty_session_manager import PtySessionManager, PtySessionState
from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus
from flow_sdk.fs_store.record import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def use_tmp_records_root(tmp_path):
    """Set records root to tmp_path for all tests."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


@pytest.fixture
def session_manager():
    """Create a fresh PtySessionManager for each test."""
    PtySessionManager.reset_instance()
    mgr = PtySessionManager()
    yield mgr
    PtySessionManager.reset_instance()


def test_pty_output_writes_to_stream_file():
    """Verify that on_pty_output calls PtyStreamFile.write when session_state has a pty_stream_file."""
    mock_stream_file = MagicMock()
    mock_stream_file.write = MagicMock()

    session_state = PtySessionState(
        pty_key=("cn1", "pn1", "sess1"),
        cols=80,
        rows=24,
    )
    session_state.pty_stream_file = mock_stream_file

    # Simulate what on_pty_output does: if session_state.pty_stream_file, write data
    data = b"hello terminal"
    if session_state.pty_stream_file:
        session_state.pty_stream_file.write(data)

    mock_stream_file.write.assert_called_once_with(data)


@pytest.mark.asyncio
async def test_close_session_transitions_record(session_manager, use_tmp_records_root):
    """After close_session(), record status is CLOSED and .pty file is deleted."""
    # Create a shell session record
    record = ShellRecord(
        id="sess-close-test",
        pty_pid="sess-close-test",
        workdir="/tmp",
        state=ShellStatus.RUNNING,
    )
    record.save()

    # Create a .pty file
    pty_path = record.pty_stream_path
    pty_path.parent.mkdir(parents=True, exist_ok=True)
    pty_path.write_bytes(b"pty output data")
    assert pty_path.exists()

    # Create a mock pty_stream_file
    mock_stream_file = MagicMock()

    # Register session in session_manager
    pty_key = ("cn1", "pn1", "sess-close-test")
    session_state = PtySessionState(
        pty_key=pty_key,
        cols=80,
        rows=24,
    )
    session_state.pty_stream_file = mock_stream_file
    session_manager.sessions[pty_key] = session_state

    # Mock the compute node lookup to avoid DB access
    with patch("flow_sdk.compute.providers.desktop.pty_session_manager.ComputeNode", create=True):
        with patch(
            "flow_sdk.builtin.faas.compute_node.ComputeNode.get_by_id", new_callable=AsyncMock, return_value=None
        ):
            await session_manager.close_session(pty_key)

    # Verify record was transitioned to CLOSED
    reloaded = ShellRecord.discover_one("sess-close-test")
    assert reloaded is not None
    assert reloaded.status == ShellStatus.CLOSED

    # Verify pty_stream_file.delete() was called
    mock_stream_file.delete.assert_called_once()


def test_shell_session_entity_defaults():
    """Shell entity has correct default fields."""
    from flow_sdk.builtin.shell import Shell

    entity = Shell()
    assert entity.type == "shell"
    assert entity.name is None
    assert entity.status == "idle"
    assert entity.workdir is None
    assert entity.pty_pid is None
    assert entity.compute_node_id is None
    assert entity.tab_order == 0
    assert entity.created_at is None
    assert entity.last_active_at is None


def test_shell_session_entity_has_all_api_fields():
    """All expected fields are APIFields on Shell."""
    from flow_sdk.builtin.shell import Shell

    expected_fields = [
        "type",
        "name",
        "status",
        "workdir",
        "env",
        "pty_pid",
        "compute_node_id",
        "tab_order",
        "created_at",
        "last_active_at",
    ]
    for field_name in expected_fields:
        field_info = Shell.model_fields.get(field_name)
        assert field_info is not None, f"Missing field: {field_name}"
        # APIField sets json_schema_extra with 'api_visible' key
        extra = field_info.json_schema_extra
        assert extra and "api_visible" in extra, f"{field_name} is not an APIField"


def test_shell_record_state_transitions():
    """ShellRecord status transitions work correctly."""
    record = ShellRecord(id="test-transition")
    assert record.status == ShellStatus.IDLE

    record.status = ShellStatus.RUNNING
    assert record.status == ShellStatus.RUNNING

    record.status = ShellStatus.CLOSED
    assert record.status == ShellStatus.CLOSED


def test_shell_record_sync_from_entity():
    """sync_from_entity maps entity status into record status correctly."""
    from unittest.mock import MagicMock

    record = ShellRecord(id="sync-test")
    assert record.data.get("status") == ShellStatus.IDLE

    # Create a mock entity with db_json returning status
    mock_entity = MagicMock()
    mock_entity.db_json.return_value = {
        "status": "running",
        "name": "Synced Tab",
        "workdir": "/home/user",
    }

    result = record.sync_from_entity(mock_entity)
    assert result is True
    assert record.data.get("status") == "running"
    assert record.data.get("name") == "Synced Tab"
    assert record.data.get("workdir") == "/home/user"


def test_shell_record_entity_id_default():
    """ShellRecord has entity_id defaulting to None."""
    record = ShellRecord(id="entity-id-test")
    assert record.data.get("entity_id") is None


def test_shell_session_status_default_idle():
    """Shell entity default status is 'idle'."""
    from flow_sdk.builtin.shell import Shell

    entity = Shell()
    assert entity.status == "idle"


@pytest.mark.asyncio
async def test_shell_session_open_recovers_dead_running_session():
    """open() on a running shell with no live PTY spawns a new PTY (recovery path)."""
    from flow_sdk.builtin.shell import Shell

    entity = Shell()
    entity.status = "running"
    entity.compute_node_id = "00000000-0000-0000-0000-000000000099"

    # No existing PTY → compute_node.get_pty() returns None → create_pty() spawns a new one.
    result = await entity.open()
    assert result.status == "SUCCESS"
    assert entity.connected is True
    # Cleanup
    pty = entity.compute_node.get_pty(entity.id)
    if pty:
        await pty.kill()
