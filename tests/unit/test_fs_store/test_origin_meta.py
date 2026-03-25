"""Tests for origin ref pattern — origin_ref links a derived record to its source.

Note: The `meta` and `get_or_create_meta()` APIs were removed in the record-strip
refactor. This file tests the remaining origin_ref behavior only.
"""

import json

import pytest

from flow_sdk.fs_store import Record, RecordRef
from flow_sdk.fs_store import set_default_records_root, get_default_records_root


@pytest.fixture(autouse=True)
def _isolate_records_root(tmp_path):
    """Redirect the default records root to a temp dir for every test."""
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


class TestOriginRef:
    def test_origin_ref_defaults_to_none(self):
        rec = Record(id="sess-1", type="session", name="My Session")
        assert rec.origin_ref is None

    def test_origin_ref_set_and_get(self):
        rec = Record(id="sess-1", type="session")
        rec.origin_ref = RecordRef(id="orig-1", type="session", path="/fake/path")
        assert rec.origin_ref is not None
        assert rec.origin_ref.id == "orig-1"
        assert rec.origin_ref.path == "/fake/path"

    def test_origin_ref_round_trip(self, tmp_path):
        rec = Record(id="sess-1", type="session", name="Ref Check")
        rec.origin_ref = RecordRef(id="sess-1", type="session", path="/fake/session.jsonl")
        rec.save()

        # save() writes to records_root shadow folder; load from there
        from flow_sdk.fs_store import get_default_records_root
        shadow_folder = get_default_records_root() / "session" / "session-@sess-1"
        loaded = Record.load(shadow_folder)
        assert loaded.origin_ref is not None
        assert loaded.origin_ref.id == "sess-1"
        assert loaded.origin_ref.path == "/fake/session.jsonl"

    def test_origin_serialized_as_origin_key(self, tmp_path):
        folder = tmp_path / "entity"
        rec = Record.init_record(
            {"id": "sess-7", "type": "session", "name": "Serialization"}, folder
        )
        rec.origin_ref = RecordRef(id="sess-7", type="session", path="/src/session.jsonl")
        rec.save()

        # origin is a meta field stored in metadata.json (promoted from domain in Rule 7)
        from pathlib import Path
        from flow_sdk.fs_store.record import _META_JSON
        meta_file = Path(rec.path) / _META_JSON
        raw = json.loads(meta_file.read_text())
        data = raw.get("data", raw)
        assert "origin" in data
        assert data["origin"]["id"] == "sess-7"
        assert data["origin"]["type"] == "session"
        assert data["origin"]["path"] == "/src/session.jsonl"
