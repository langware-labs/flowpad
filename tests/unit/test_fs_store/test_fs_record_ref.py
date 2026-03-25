"""Tests for RecordRef -- lightweight record reference."""

from flow_sdk.fs_store import RecordRef, Record


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

    def test_from_record_with_source_file(self):
        record = Record(id="r2", type="session", source_file="/tmp/r.json")
        ref = RecordRef.from_record(record)
        assert ref.path == "/tmp/r.json"
