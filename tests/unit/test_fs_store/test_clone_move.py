"""Tests for Record clone, move, and delete operations."""

import json

import pytest

from flow_sdk.fs_store import Record, RecordRef, ReadOnlyRecordError


class TestClone:
    def test_clone_creates_new_id(self, tmp_path):
        src = tmp_path / "src"
        rec = Record._init_record({"id": "orig", "type": "test", "name": "hello"}, src)

        dst = tmp_path / "dst"
        clone = rec.clone(dst)
        assert clone.id != "orig"

    def test_clone_preserves_data(self, tmp_path):
        src = tmp_path / "src"
        rec = Record._init_record({"id": "orig", "type": "test", "name": "hello"}, src)

        dst = tmp_path / "dst"
        clone = rec.clone(dst)
        assert clone.type == "test"
        assert clone.name == "hello"

    def test_clone_sets_origin_ref(self, tmp_path):
        src = tmp_path / "src"
        rec = Record._init_record({"id": "orig", "type": "test"}, src)

        dst = tmp_path / "dst"
        clone = rec.clone(dst)
        assert clone.origin_ref is not None
        assert isinstance(clone.origin_ref, RecordRef)
        assert clone.origin_ref.id == "orig"
        assert clone.origin_ref.type == "test"

    def test_clone_writes_to_new_path(self, tmp_path):
        src = tmp_path / "src"
        rec = Record._init_record({"id": "orig", "type": "test"}, src)

        dst = tmp_path / "dst"
        clone = rec.clone(dst)
        assert (dst / "metadata.json").exists()

    def test_clone_original_unchanged(self, tmp_path):
        src = tmp_path / "src"
        rec = Record._init_record({"id": "orig", "type": "test", "name": "hello"}, src)

        dst = tmp_path / "dst"
        clone = rec.clone(dst)
        # Original unchanged
        assert rec.id == "orig"
        assert rec.origin_ref is None

    def test_clone_read_only_raises(self, tmp_path):
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord
        rec = ClaudeSessionFsRecord(id="s1")
        with pytest.raises(ReadOnlyRecordError):
            rec.clone(tmp_path / "dst")


class TestMove:
    def test_move_keeps_same_id(self, tmp_path):
        src = tmp_path / "src"
        rec = Record._init_record({"id": "m1", "type": "test"}, src)

        dst = tmp_path / "dst"
        rec.move(dst)
        assert rec.id == "m1"

    def test_move_updates_source_file(self, tmp_path):
        src = tmp_path / "src"
        rec = Record._init_record({"id": "m1", "type": "test"}, src)

        dst = tmp_path / "dst"
        rec.move(dst)
        assert str(dst) in rec.source_file

    def test_move_removes_old_location(self, tmp_path):
        src = tmp_path / "src"
        rec = Record._init_record({"id": "m1", "type": "test"}, src)
        assert src.exists()

        dst = tmp_path / "dst"
        rec.move(dst)
        assert not src.exists()
        assert (dst / "metadata.json").exists()

    def test_move_read_only_raises(self, tmp_path):
        from flow_sdk.fs_records.claude.claude_session import ClaudeSessionFsRecord
        rec = ClaudeSessionFsRecord(id="s1")
        with pytest.raises(ReadOnlyRecordError):
            rec.move(tmp_path / "dst")


class TestDelete:
    @pytest.mark.asyncio
    async def test_delete_folder_layout(self, tmp_path):
        folder = tmp_path / "entity"
        rec = Record._init_record({"id": "d1", "type": "test"}, folder)
        assert folder.exists()

        await rec.delete()
        assert not folder.exists()
        assert rec.source_file is None
        assert rec.path is None

    @pytest.mark.asyncio
    async def test_delete_folder_layout_explicit(self, tmp_path):
        """Verify folder layout: folder exists after create, gone after delete."""
        folder = tmp_path / "entity2"
        rec = Record._init_record({"id": "d1", "type": "test"}, folder)
        assert folder.exists()

        await rec.delete()
        assert not folder.exists()
        assert rec.source_file is None

    @pytest.mark.asyncio
    async def test_delete_nonexistent_is_safe(self, tmp_path):
        rec = Record(id="d1", type="test")
        rec.source_file = str(tmp_path / "missing.json")
        # Should not raise
        await rec.delete()
        assert rec.source_file is None


class TestOriginRef:
    def test_origin_ref_round_trip(self, tmp_path):
        """Serialize and deserialize origin_ref."""
        src = tmp_path / "src"
        rec = Record._init_record({"id": "orig", "type": "test"}, src)

        dst = tmp_path / "dst"
        clone = rec.clone(dst)

        # Reload the clone from disk
        loaded = Record.load_record(dst)
        assert loaded.origin_ref is not None
        assert loaded.origin_ref.id == "orig"
        assert loaded.origin_ref.type == "test"

    def test_origin_ref_not_in_to_dict_when_none(self):
        rec = Record(id="x")
        d = rec.meta_dict()
        assert "origin" not in d

    def test_origin_ref_in_to_dict_when_set(self):
        rec = Record(id="x", origin_ref=RecordRef(id="src", type="test"))
        d = rec.meta_dict()
        assert "origin" in d
        assert d["origin"]["id"] == "src"
