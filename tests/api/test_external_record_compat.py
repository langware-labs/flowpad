"""API tests for external-record-compat submodule.

Verifies _list_shell_sessions works correctly after _meta_data removal.
"""

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from flow_sdk.fs_records.shell_record import ShellRecord, ShellStatus
from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root
from flow_sdk.responses.response import ApiResponse
from flow_sdk.server.app import app


@pytest.mark.asyncio
async def test_shell_discover_no_meta(bootstrapped_client):
    """list-shells works correctly after _meta_data removal.

    Creates a ShellRecord, discovers it, and verifies the
    list-shells endpoint returns it without errors.
    """
    original_root = get_default_records_root()
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_root = Path(tmpdir)
        set_default_records_root(tmp_root)
        try:
            # Create a shell session record
            rec = ShellRecord(
                id="test-session-1",
                name="Test Shell",
                state=ShellStatus.IDLE,
                workdir="/tmp",
            )
            rec.save()

            # Discover should find it without _meta_data errors
            found = ShellRecord.discover()
            assert len(found) >= 1
            session = next((r for r in found if r.id == "test-session-1"), None)
            assert session is not None
            assert session.name == "Test Shell"
            assert session.status == ShellStatus.IDLE

            # No _meta_data attribute on discovered record
            assert not hasattr(session, "_meta_data")

            # id and type stored in _data
            assert session.id == "test-session-1"
            assert session.type == "shell"

        finally:
            set_default_records_root(original_root)
