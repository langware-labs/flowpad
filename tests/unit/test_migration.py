"""Unit tests for migration-path submodule.

Tests for:
- _migrate_old_format(): filesystem migration from .flow_record/record.json to data.json
- _parse_vfs_uri_to_ref(): VFS URI parsing
"""

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.record import _migrate_old_format, _DATA_JSON


class TestMigrateOldFormat:
    """Tests for _migrate_old_format()."""

    def test_migrate_old_format_happy(self, tmp_path: Path):
        """Old .flow_record/record.json converted to data.json; .flow_record/ removed."""
        folder = tmp_path / "shell_session-@abc123"
        folder.mkdir()
        old_dir = folder / ".flow_record"
        old_dir.mkdir()
        old_record = {
            "id": "abc123",
            "type": "shell_session",
            "name": "My Session",
            "status": "active",
            # Old meta fields that should be stripped
            "created_at": "2026-01-01T00:00:00Z",
            "modified_at": "2026-01-02T00:00:00Z",
            "created_by": "local",
            "updated_by": "local",
            "scope": "project",
            "entity_id": "ent-123",
            "json_path": "/some/path",
            # Domain field
            "description": "A test session",
        }
        (old_dir / "record.json").write_text(json.dumps(old_record))

        result = _migrate_old_format(folder)

        # Returns domain data without meta fields
        assert result is not None
        assert result["id"] == "abc123"
        assert result["type"] == "shell_session"
        assert result["name"] == "My Session"
        assert result["description"] == "A test session"
        # Meta fields stripped
        assert "created_at" not in result
        assert "modified_at" not in result
        assert "created_by" not in result
        assert "entity_id" not in result

        # metadata.json written in wrapped format
        data_file = folder / "metadata.json"
        assert data_file.exists()
        raw = json.loads(data_file.read_text())
        assert "data" in raw
        assert raw["data"]["id"] == "abc123"
        assert "created_at" not in raw["data"]

        # .flow_record/ removed
        assert not old_dir.exists()

    def test_migrate_old_format_no_old_file(self, tmp_path: Path):
        """Returns None when no .flow_record/record.json exists."""
        folder = tmp_path / "shell_session-@xyz"
        folder.mkdir()

        result = _migrate_old_format(folder)
        assert result is None

    def test_migrate_old_format_malformed_json(self, tmp_path: Path):
        """Handles malformed JSON gracefully (returns None, does not crash)."""
        folder = tmp_path / "shell_session-@bad"
        folder.mkdir()
        old_dir = folder / ".flow_record"
        old_dir.mkdir()
        (old_dir / "record.json").write_text("not valid json {{{")

        result = _migrate_old_format(folder)
        assert result is None
        # Old dir should still exist since we didn't write data.json
        assert old_dir.exists()

    def test_migrate_old_format_preserves_custom_fields(self, tmp_path: Path):
        """Custom domain fields are preserved through migration."""
        folder = tmp_path / "note-@n1"
        folder.mkdir()
        old_dir = folder / ".flow_record"
        old_dir.mkdir()
        old_record = {
            "id": "n1",
            "type": "note",
            "custom_field": "value",
            "tags": ["a", "b"],
            "nested": {"key": "val"},
        }
        (old_dir / "record.json").write_text(json.dumps(old_record))

        result = _migrate_old_format(folder)
        assert result is not None
        assert result["custom_field"] == "value"
        assert result["tags"] == ["a", "b"]
        assert result["nested"] == {"key": "val"}

    def test_migrate_old_format_does_not_overwrite_existing_data_json(self, tmp_path: Path):
        """If data.json already exists alongside .flow_record, migration still runs
        (overwrites data.json with migrated content from old format)."""
        folder = tmp_path / "session-@s1"
        folder.mkdir()
        old_dir = folder / ".flow_record"
        old_dir.mkdir()
        (old_dir / "record.json").write_text(json.dumps({"id": "s1", "type": "session"}))
        # Pre-existing data.json
        (folder / _DATA_JSON).write_text(json.dumps({"data": {"id": "old"}}))

        result = _migrate_old_format(folder)
        assert result is not None
        assert result["id"] == "s1"


class TestParseVfsUri:
    """Tests for _parse_vfs_uri_to_ref()."""

    def test_parse_vfs_uri_valid(self):
        from flow_sdk.db.drivers.sqlite.sqlite_driver import _parse_vfs_uri_to_ref

        result = _parse_vfs_uri_to_ref(
            "vfs://compute_node-@local/records/shell_session/shell_session-@abc123"
        )
        assert result == ("shell_session", "abc123")

    def test_parse_vfs_uri_simple(self):
        from flow_sdk.db.drivers.sqlite.sqlite_driver import _parse_vfs_uri_to_ref

        result = _parse_vfs_uri_to_ref("vfs://compute_node-@local/note-@xyz")
        assert result == ("note", "xyz")

    def test_parse_vfs_uri_multiple_segments(self):
        """Extracts the LAST segment with -@."""
        from flow_sdk.db.drivers.sqlite.sqlite_driver import _parse_vfs_uri_to_ref

        result = _parse_vfs_uri_to_ref(
            "vfs://compute_node-@local/workspace-@ws1/shell_session-@sess42"
        )
        assert result == ("shell_session", "sess42")

    def test_parse_vfs_uri_malformed(self):
        from flow_sdk.db.drivers.sqlite.sqlite_driver import _parse_vfs_uri_to_ref

        with pytest.raises(ValueError, match="No valid"):
            _parse_vfs_uri_to_ref("garbage")

    def test_parse_vfs_uri_empty(self):
        from flow_sdk.db.drivers.sqlite.sqlite_driver import _parse_vfs_uri_to_ref

        with pytest.raises(ValueError, match="Invalid VFS URI"):
            _parse_vfs_uri_to_ref("")

    def test_parse_vfs_uri_none(self):
        from flow_sdk.db.drivers.sqlite.sqlite_driver import _parse_vfs_uri_to_ref

        with pytest.raises(ValueError, match="Invalid VFS URI"):
            _parse_vfs_uri_to_ref(None)
