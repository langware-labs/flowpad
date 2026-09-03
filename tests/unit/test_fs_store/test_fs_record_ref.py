"""Tests for RecordRef -- lightweight record reference."""

from flow_sdk.fs_store import RecordRef
from flow_sdk.fs_store.fs_record import FSRecord as Record


class TestConstruction:
    def test_basic(self):
        ref = RecordRef(id="a", type="task")
        assert ref.id == "a"
        assert ref.type == "task"
        assert ref.path is None

    def test_with_path(self):
        ref = RecordRef(id="b", type="session", path="/tmp/b.json")
        assert ref.path == "/tmp/b.json"


class TestToDict:
    def test_omits_none_path(self):
        d = RecordRef(id="a", type="task").to_dict()
        assert d == {"id": "a", "type": "task"}
        assert "path" not in d

    def test_includes_path_when_set(self):
        d = RecordRef(id="a", type="task", path="/p").to_dict()
        assert d == {"id": "a", "type": "task", "path": "/p"}


class TestFromDict:
    def test_basic(self):
        ref = RecordRef.from_dict({"id": "x", "type": "rule"})
        assert ref.id == "x"
        assert ref.type == "rule"

    def test_ignores_extra_keys(self):
        ref = RecordRef.from_dict({"id": "x", "type": "t", "name": "n", "scope": "user"})
        assert ref.id == "x"
        assert ref.type == "t"

    def test_missing_type_defaults_to_empty(self):
        ref = RecordRef.from_dict({"id": "x"})
        assert ref.type == ""

    def test_with_path(self):
        ref = RecordRef.from_dict({"id": "x", "type": "t", "path": "/p"})
        assert ref.path == "/p"


class TestRoundTrip:
    def test_round_trip_without_path(self):
        original = RecordRef(id="a", type="task")
        restored = RecordRef.from_dict(original.to_dict())
        assert restored.id == original.id
        assert restored.type == original.type
        assert restored.path is None

    def test_round_trip_with_path(self):
        original = RecordRef(id="b", type="session", path="/tmp/b.json")
        restored = RecordRef.from_dict(original.to_dict())
        assert restored.id == original.id
        assert restored.type == original.type
        assert restored.path == original.path


class TestFromRecord:
    def test_from_resource_record(self):
        record = Record(id="r1", type="task")
        ref = RecordRef.from_record(record)
        assert ref.id == "r1"
        assert ref.type == "task"
        assert ref.path is None

    def test_from_record_with_asset_ref(self):
        # FSRecord carries its file as ``asset_ref`` (an FSRef); the ref's
        # ``path`` is that file. ``source_file`` was a Record-era attribute
        # FSRecord never had, so the ref used to come back path-less.
        record = Record(id="r2", type="session", asset_ref="/var/data/r.json")
        ref = RecordRef.from_record(record)
        assert ref.path == record.asset_ref.path
        assert ref.path.endswith("/r.json")

    def test_from_duck_typed_record_with_string_asset_ref(self):
        class _Duck:
            id = "r3"
            type = "note"
            asset_ref = "/tmp/n.md"

        assert RecordRef.from_record(_Duck()).path == "/tmp/n.md"
