"""Tests for RecordDataRef (Sub 2: record-data-ref)."""

from pathlib import Path

from flow_sdk.fs_store.record_paths import get_default_records_data_root, set_default_records_data_root
from flow_sdk.fs_store.record_ref import RecordDataRef, RecordRef


class TestRecordDataRef:
    def test_from_entity_ref_parses_type_and_id(self):
        ref = RecordDataRef.from_entity_ref("skill/my-skill")
        assert ref.type == "skill"
        assert ref.id == "my-skill"

    def test_to_entity_ref_roundtrip(self):
        ref = RecordDataRef(id="abc-123", type="workflow")
        entity_ref = ref.to_entity_ref()
        assert entity_ref == "workflow/abc-123"
        roundtripped = RecordDataRef.from_entity_ref(entity_ref)
        assert roundtripped.type == ref.type
        assert roundtripped.id == ref.id

    def test_resolve_data_dir_returns_data_subfolder(self, tmp_path):
        original = get_default_records_data_root()
        try:
            set_default_records_data_root(tmp_path)
            ref = RecordDataRef(id="test-001", type="test_record")
            data_dir = ref.resolve_data_dir()
            assert data_dir == tmp_path / "test_record" / "test-001"
        finally:
            set_default_records_data_root(original)

    def test_resolve_data_dir_with_explicit_root(self, tmp_path):
        ref = RecordDataRef(id="test-001", type="test_record")
        data_dir = ref.resolve_data_dir(records_root=tmp_path)
        assert data_dir == tmp_path / "test_record" / "test-001"

    def test_resolve_data_file_default_is_data_json(self, tmp_path):
        ref = RecordDataRef(id="test-001", type="test_record")
        data_file = ref.resolve_data_file(records_root=tmp_path)
        assert data_file == tmp_path / "test_record" / "test-001" / "_obj_data.json"

    def test_resolve_data_file_with_absolute_path(self, tmp_path):
        abs_path = str(tmp_path / "custom" / "data.json")
        ref = RecordDataRef(id="test-001", type="test_record", path=abs_path)
        data_file = ref.resolve_data_file(records_root=tmp_path)
        assert data_file == Path(abs_path)

    def test_from_dict_returns_record_data_ref_when_format_present(self):
        data = {"id": "x", "type": "skill", "format": "json"}
        ref = RecordRef.from_dict(data)
        assert isinstance(ref, RecordDataRef)
        assert ref.format == "json"
        assert ref.id == "x"
        assert ref.type == "skill"

    def test_from_dict_returns_record_ref_without_format(self):
        data = {"id": "x", "type": "skill"}
        ref = RecordRef.from_dict(data)
        assert type(ref) is RecordRef
        assert not isinstance(ref, RecordDataRef)

    def test_from_record_builds_ref(self):
        class FakeRecord:
            id = "rec-001"
            type = "bookmark"
            source_file = "/tmp/bookmark.json"

        ref = RecordDataRef.from_record(FakeRecord())
        assert ref.id == "rec-001"
        assert ref.type == "bookmark"
        assert ref.path == "/tmp/bookmark.json"

    def test_content_hash_stable(self):
        ref1 = RecordDataRef(id="a", type="b", path="/x")
        ref2 = RecordDataRef(id="a", type="b", path="/x")
        assert ref1.content_hash == ref2.content_hash

    def test_to_dict_includes_format(self):
        ref = RecordDataRef(id="a", type="b", format="jsonl")
        d = ref.to_dict()
        assert d["format"] == "jsonl"
        assert d["id"] == "a"
        assert d["type"] == "b"

    def test_to_dict_omits_none_format(self):
        ref = RecordDataRef(id="a", type="b")
        d = ref.to_dict()
        assert "format" not in d

    def test_resolve_data_dir_returns_none_without_type(self, tmp_path):
        ref = RecordDataRef(id="x")
        assert ref.resolve_data_dir(records_root=tmp_path) is None

    def test_resolve_data_dir_returns_none_without_id(self, tmp_path):
        ref = RecordDataRef(type="x")
        assert ref.resolve_data_dir(records_root=tmp_path) is None
