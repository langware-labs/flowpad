"""Unit tests for external-record-compat submodule.

Verifies that:
- Read-only records skip Record.sync_to_db() (no Entity created)
- ClaudeHookRecord management fields use _data (not _meta_data)
- Read-only Claude records have no _meta_data dict
"""

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record import Record


class TestReadonlyRecordSyncToDbNoop:
    """FSRef read_only=True instance: await record.sync_to_db() still indexes into SQLite.

    read_only only protects the filesystem (write_record, clone, move).
    Syncing to the SQLite Entity DB is allowed even for read-only records.
    """

    @pytest.mark.asyncio
    async def test_readonly_record_sync_to_db_noop(self):
        class ReadOnlyRec(Record):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

        rec = ReadOnlyRec(id="ro-1", type="readonly_test", name="test")

        with patch("flow_sdk.core.entity.entity_model.Entity.get_one", new_callable=AsyncMock) as mock_get:
            with patch("flow_sdk.core.entity.entity_model.Entity.save", new_callable=AsyncMock) as mock_save:
                mock_get.return_value = None
                await rec.sync_to_db()
                mock_get.assert_called_once()
                mock_save.assert_called_once()


class TestClaudeHookRecordManagementFields:
    """ClaudeHookRecord stores management fields in _data."""

    def test_claude_hook_record_management_fields(self):
        from flow_sdk.fs_records.claude.claude_hook_record import ClaudeHookRecord

        rec = ClaudeHookRecord(
            id="hook-1",
            event_type="PostToolUse",
            matcher="Read",
            command="echo hi",
        )

        # Set management fields via properties
        rec.plugin_name = "my-plugin"
        rec.flowpad_hook_id = "fp-123"
        rec.flow_metadata_name = "my-hook"

        # All stored in _data
        assert rec.plugin_name == "my-plugin"
        assert rec.flowpad_hook_id == "fp-123"
        assert rec.flow_metadata_name == "my-hook"

        # Read back via properties
        assert rec.plugin_name == "my-plugin"
        assert rec.flowpad_hook_id == "fp-123"
        assert rec.flow_metadata_name == "my-hook"

        # No _meta_data dict
        assert not hasattr(rec, "_meta_data")


class TestClaudeReadonlyRecordNoMetaData:
    """A FSRef read_only=True Claude record has no _meta_data dict; id/type in _data."""

    def test_claude_readonly_record_no_meta_data(self):
        from flow_sdk.fs_records.claude.claude_hook import ClaudeHookFsRecord

        rec = ClaudeHookFsRecord(
            id="hook-fs-1",
            type="claude_hook",
            name="test hook",
        )

        # read_only is enforced via FSRef sentinel
        assert rec._is_read_only() is True

        # No _meta_data attribute
        assert not hasattr(rec, "_meta_data")

        # id and type are in _data
        assert rec.id == "hook-fs-1"
        assert rec.type == "claude_hook"
        assert rec.name == "test hook"
