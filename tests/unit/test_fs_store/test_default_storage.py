"""Tests for default .flow/records fallback storage."""

import json
from typing import ClassVar

import pytest

from flow_sdk.fs_store import Record, ResourceRecordList
from flow_sdk.fs_store import get_default_records_root, set_default_records_root


@pytest.fixture(autouse=True)
def _isolate_default_root(tmp_path):
    """Override the default records root to a temp dir for test isolation."""
    original = get_default_records_root()
    set_default_records_root(tmp_path / "flow_records")
    yield
    set_default_records_root(original)


class TestDefaultStorage:
    def test_save_without_path_uses_default(self, tmp_path):
        rec = Record(id="t1", type="test", name="hello")
        rec.save()
        # New split format: id/type/name go to metadata.json
        expected = tmp_path / "flow_records" / "test" / "test-@t1" / "metadata.json"
        assert expected.exists()
        raw = json.loads(expected.read_text())
        data = raw.get("data", raw)
        assert data["id"] == "t1"
        assert data["name"] == "hello"

    def test_default_path_property(self, tmp_path):
        rec = Record(id="dp1", type="task")
        dp = rec.default_path
        assert dp is not None
        assert dp == tmp_path / "flow_records" / "task" / "task-@dp1"

    def test_default_path_none_without_type(self):
        rec = Record(id="x")
        assert rec.default_path is None

    def test_record_list_defaults_to_flow_records(self, tmp_path):
        """ResourceRecordList with no records_path falls back to default root."""

        class TypedRecord(Record):
            _record_type: ClassVar[str] = "test"
            def __init__(self, **kwargs):
                kwargs.setdefault("type", "test")
                super().__init__(**kwargs)

        rl = ResourceRecordList(record_class=TypedRecord)
        assert rl.list_path == tmp_path / "flow_records" / "test"

    def test_set_default_records_root_override(self, tmp_path):
        custom = tmp_path / "custom_root"
        set_default_records_root(custom)
        assert get_default_records_root() == custom

        rec = Record(id="c1", type="test")
        assert rec.default_path == custom / "test" / "test-@c1"
