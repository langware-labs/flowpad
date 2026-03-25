"""Tests for ResourceRecordList — CRUD with folder-based storage."""

from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.fs_store import Record, ResourceRecordList


# ---------------------------------------------------------------------------
# Typed test records (ResourceRecordList requires a default type)
# ---------------------------------------------------------------------------

class TestRecord(Record):
    """Minimal typed record for tests."""
    _record_type: ClassVar[str] = "test"

    def __init__(self, **kwargs):
        kwargs.setdefault("type", "test")
        super().__init__(**kwargs)


class TaggedRecord(Record):
    """Record with an extra tag_id field (non-uid)."""
    _record_type: ClassVar[str] = "tag"

    def __init__(self, **kwargs):
        kwargs.setdefault("type", "tag")
        super().__init__(**kwargs)


def _make_list(tmp_path: Path, record_class=TestRecord) -> ResourceRecordList:
    return ResourceRecordList(
        record_class=record_class,
        records_path=tmp_path,
    )


# ---------------------------------------------------------------------------
# CRUD operations
# ---------------------------------------------------------------------------

class TestCrud:
    """CRUD operations for folder-layout storage."""

    def test_create_and_get(self, tmp_path):
        rl = _make_list(tmp_path)
        r = rl.create(TestRecord(id="1", name="alpha"))
        assert r.id == "1"
        fetched = rl.get("1")
        assert fetched.id == "1"
        assert fetched.name == "alpha"
        assert len(rl) == 1

    def test_create_from_dict(self, tmp_path):
        rl = _make_list(tmp_path)
        r = rl.create({"id": "d1", "type": "test", "name": "from-dict"})
        assert r.id == "d1"
        assert r.name == "from-dict"
        assert rl.get("d1").name == "from-dict"

    def test_create_duplicate_raises(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="dup"))
        with pytest.raises(ValueError, match="already exists"):
            rl.create(TestRecord(id="dup"))

    def test_get_missing_returns_none(self, tmp_path):
        rl = _make_list(tmp_path)
        assert rl.get("nope") is None

    def test_update(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="u1", name="before"))
        updated = rl.update("u1", {"name": "after", "custom": 42})
        assert updated.name == "after"
        assert updated.raw_json["custom"] == 42
        # verify persisted
        fetched = rl.get("u1")
        assert fetched.name == "after"
        assert fetched.raw_json["custom"] == 42

    def test_update_missing_raises(self, tmp_path):
        rl = _make_list(tmp_path)
        with pytest.raises(KeyError, match="No record"):
            rl.update("nope", {"name": "x"})

    def test_delete(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="d1"))
        assert rl.delete("d1") is True
        assert len(rl) == 0
        assert rl.get("d1") is None

    def test_delete_missing_returns_false(self, tmp_path):
        rl = _make_list(tmp_path)
        assert rl.delete("ghost") is False

    def test_iteration(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="a"))
        rl.create(TestRecord(id="b"))
        ids = [r.id for r in rl]
        assert "a" in ids
        assert "b" in ids

    def test_records_property(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="r1"))
        recs = rl.records
        assert len(recs) == 1
        assert recs[0].id == "r1"


# ---------------------------------------------------------------------------
# Persistence: second instance reads from disk
# ---------------------------------------------------------------------------

class TestPersistence:
    def test_create_persists_to_disk(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="s1", name="first"))
        rl.create(TestRecord(id="s2", name="second"))

        rl2 = _make_list(tmp_path)
        assert rl2.get("s1").name == "first"
        assert rl2.get("s2").name == "second"
        assert len(rl2) == 2

    def test_delete_removes_from_disk(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="x1", name="keep"))
        rl.create(TestRecord(id="x2", name="remove"))

        rl.delete("x2")

        rl2 = _make_list(tmp_path)
        assert rl2.get("x1").name == "keep"
        assert rl2.get("x2") is None
        assert len(rl2) == 1

    def test_update_persists(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="u1", name="v1"))
        rl.update("u1", {"name": "v2"})

        rl2 = _make_list(tmp_path)
        assert rl2.get("u1").name == "v2"

    def test_save_overwrites(self, tmp_path):
        rl = _make_list(tmp_path)
        rec = rl.create(TestRecord(id="s1", name="original"))
        rec.name = "modified"
        rl.save(rec)

        rl2 = _make_list(tmp_path)
        assert rl2.get("s1").name == "modified"


# ---------------------------------------------------------------------------
# Naming convention: <type>-@<uid>
# ---------------------------------------------------------------------------

class TestNamingConvention:
    def test_folder_layout_uses_stem(self, tmp_path):
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="def", name="s1"))
        expected_dir = tmp_path / "test" / "test-@def"
        assert expected_dir.is_dir()
        assert (expected_dir / "data.json").exists()

    def test_folder_record_has_path(self, tmp_path):
        rl = _make_list(tmp_path)
        r = rl.create(TestRecord(id="p1"))
        assert r.path == str(tmp_path / "test" / "test-@p1")


# ---------------------------------------------------------------------------
# Records use id as the sole identity key
# ---------------------------------------------------------------------------

class TestRecordIdentity:
    def test_crud_uses_id(self, tmp_path):
        rl = _make_list(tmp_path, record_class=TaggedRecord)
        r = rl.create(TaggedRecord(id="t-1", name="first"))
        assert r.id == "t-1"
        assert rl.get("t-1").name == "first"

        rl.update("t-1", {"name": "updated"})

        rl2 = _make_list(tmp_path, record_class=TaggedRecord)
        assert rl2.get("t-1").name == "updated"

    def test_folder_layout_uses_id(self, tmp_path):
        rl = _make_list(tmp_path, record_class=TaggedRecord)
        rl.create(TaggedRecord(id="tg-99"))
        expected = tmp_path / "tag" / "tag-@tg-99"
        assert expected.is_dir()


# ---------------------------------------------------------------------------
# FOLDER layout: extra files alongside record.json
# ---------------------------------------------------------------------------

class TestFolderExtraFiles:
    def test_folder_preserves_extra_files_on_save(self, tmp_path):
        """Saving a folder-layout record should not destroy sibling files."""
        rl = _make_list(tmp_path)
        rec = rl.create(TestRecord(id="f1"))

        # Simulate an output file written by the session
        output = Path(rec.path) / "output.txt"
        output.write_text("some output")

        # Re-save -- the output file should survive
        rl.update("f1", {"name": "renamed"})
        assert output.exists()
        assert output.read_text() == "some output"


# ---------------------------------------------------------------------------
# Backward compatibility: old layout (bare record.json) + new (.flow_record/)
# ---------------------------------------------------------------------------

class TestBackwardCompat:
    def test_save_writes_new_layout(self, tmp_path):
        """Creating a new record writes to data.json."""
        rl = _make_list(tmp_path)
        rl.create(TestRecord(id="new1"))
        stem_dir = rl.list_path / "test-@new1"
        assert (stem_dir / "data.json").exists()

    def test_multiple_records_iterable(self, tmp_path):
        """Multiple data.json records appear during iteration."""
        import json

        rl = _make_list(tmp_path)

        # Create records via API
        rl.create(TestRecord(id="new"))
        rl.create(TestRecord(id="other", name="another"))

        ids = [r.id for r in rl]
        assert "new" in ids
        assert "other" in ids
        assert len(rl) == 2
