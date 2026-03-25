"""Tests for record storage — Record stores fields as direct instance attributes.

Records no longer have a separate _data dict; all domain fields are stored as
direct instance attributes and serialized via to_dict().
"""

import json
import uuid
from pathlib import Path

import pytest

from flow_sdk.fs_store.record import Record, RecordStatus, _META_JSON, set_default_records_root


@pytest.fixture
def records_root(tmp_path):
    """Set default records root to tmp_path for test isolation."""
    set_default_records_root(tmp_path)
    yield tmp_path


def test_record_no_meta_data_dict():
    """Record() has no _data attribute; id, type, name accessible as direct attrs."""
    rec = Record()
    assert not hasattr(rec, "_meta_data")
    assert not hasattr(rec, "_data")  # _data is gone
    assert rec.id  # auto-generated UUID
    assert rec.data.get("id") == rec.id


def test_record_init_kwargs_to_data():
    """Record(id='x', name='y', description='z') puts all kwargs as direct attrs."""
    rec = Record(id="x", name="y", description="z")
    assert rec.data["id"] == "x"
    assert rec.data["name"] == "y"
    assert rec.data["description"] == "z"
    assert rec.id == "x"
    assert rec.name == "y"
    assert rec.description == "z"


def test_record_id_mutable():
    """record.id can be changed via the setter property."""
    rec = Record(id="original")
    rec.id = "changed"
    assert rec.data["id"] == "changed"
    assert rec.id == "changed"


def test_record_to_dict_no_meta():
    """meta_dict() returns domain fields with no meta fields separation."""
    rec = Record(id="abc", name="test", custom_field="value")
    d = rec.meta_dict()
    assert d["id"] == "abc"
    assert d["name"] == "test"
    assert d["custom_field"] == "value"
    # Internal fields excluded
    assert "source_file" not in d
    assert "path" not in d
    assert "fs_sync" not in d
    assert "storage_layout" not in d


def test_record_from_dict_all_to_attrs():
    """from_dict({'id': 'x', 'name': 'y', 'custom': 1}) sets everything as direct attrs."""
    rec = Record.from_dict({"id": "x", "name": "y", "custom": 1})
    assert rec.data["id"] == "x"
    assert rec.data["name"] == "y"
    assert rec.data["custom"] == 1
    assert rec.id == "x"
    assert rec.name == "y"


def test_record_save_writes_metadata_json(records_root):
    """record.save() creates metadata.json in record folder (split format)."""
    rec = Record(id="test123", type="test_type", name="Test")
    rec.save()

    # Check metadata.json exists (new split format)
    expected_dir = records_root / "test_type" / "test_type-@test123"
    meta_file = expected_dir / _META_JSON
    assert meta_file.exists(), f"Expected {meta_file} to exist"

    # Check old format does NOT exist
    old_file = expected_dir / ".flow_record" / "record.json"
    assert not old_file.exists(), f"Old format {old_file} should not exist"

    # Verify content is wrapped format with meta fields
    content = json.loads(meta_file.read_text())
    assert "data" in content
    assert content["data"]["id"] == "test123"
    assert content["data"]["name"] == "Test"


def test_record_no_created_at_modified_at():
    """Record has no created_at or modified_at properties; AttributeError on access."""
    rec = Record()
    with pytest.raises(AttributeError):
        _ = rec.created_at
    with pytest.raises(AttributeError):
        _ = rec.modified_at


def test_record_parent_children_in_data():
    """parent_ref and children_refs read/write backing dict entries."""
    from flow_sdk.fs_store.record_ref import RecordRef

    parent_ref = RecordRef(id="parent1", type="project")
    child_ref = RecordRef(id="child1", type="task")

    rec = Record(id="test1", type="test_type")
    rec.parent_ref = parent_ref
    rec.children_refs = [child_ref]

    # Verify accessible via data (to_dict)
    assert "parent" in rec.data
    assert "children" in rec.data
    assert rec.data["parent"]["id"] == "parent1"
    assert len(rec.data["children"]) == 1
    assert rec.data["children"][0]["id"] == "child1"

    # Verify properties work
    assert rec.parent_ref.id == "parent1"
    assert len(rec.children_refs) == 1
    assert rec.children_refs[0].id == "child1"


def test_record_type_from_classvar():
    """Record type property falls back to _record_type ClassVar."""
    class MyRecord(Record):
        _record_type = "my_type"

    rec = MyRecord()
    assert rec.type == "my_type"
    assert rec.data.get("type") == "my_type"


def test_record_status_property():
    """Status property reads/writes attrs."""
    rec = Record(id="test", status="active")
    assert rec.status == RecordStatus.ACTIVE  # coerced by from_dict or property
    # Direct setter
    rec.status = RecordStatus.NEW
    assert rec.data["status"] == RecordStatus.NEW


def test_record_load_wrapped_format(tmp_path):
    """Record.load() reads wrapped {"data": {...}} format from metadata.json."""
    folder = tmp_path / "test_type-@abc123"
    folder.mkdir()
    meta_file = folder / _META_JSON
    meta_file.write_text(json.dumps({
        "data": {"id": "abc123", "type": "test_type", "name": "loaded"}
    }))

    rec = Record.load(folder)
    assert rec.id == "abc123"
    assert rec.name == "loaded"
    assert rec.type == "test_type"


def test_record_init_record_data_path(tmp_path):
    """init_record(data, path) writes metadata.json to folder (split format)."""
    folder = tmp_path / "my_record"
    rec = Record.init_record(
        {"id": "xyz", "type": "test", "name": "from_init"},
        path=folder,
    )
    meta_file = folder / _META_JSON
    assert meta_file.exists()
    content = json.loads(meta_file.read_text())
    assert content["data"]["id"] == "xyz"
    assert content["data"]["name"] == "from_init"


def test_record_clone_writes_metadata_json(tmp_path):
    """clone() writes metadata.json (split format) instead of .flow_record/record.json."""
    rec = Record(id="orig", type="test_type", name="original")
    rec.source_file = str(tmp_path / "orig" / _META_JSON)
    rec.path = str(tmp_path / "orig")

    clone_path = tmp_path / "cloned"
    cloned = rec.clone(clone_path)
    assert cloned.id != rec.id  # new UUID
    assert (clone_path / _META_JSON).exists()
    assert not (clone_path / ".flow_record" / "record.json").exists()


def test_record_getattr_reads_attr():
    """__getattr__ reads arbitrary fields stored as instance attrs."""
    rec = Record(id="test", custom_key="custom_value")
    assert rec.custom_key == "custom_value"


def test_record_setattr_writes_attr():
    """__setattr__ writes non-internal fields directly as instance attrs."""
    rec = Record(id="test")
    rec.my_field = "hello"
    assert rec.data["my_field"] == "hello"


def test_record_contains_checks_attrs():
    """__contains__ checks domain attrs (via to_dict)."""
    rec = Record(id="test", name="hello")
    assert "id" in rec
    assert "name" in rec
    assert "nonexistent" not in rec


def test_record_keys_returns_attr_keys():
    """keys() returns domain field keys (via to_dict)."""
    rec = Record(id="test", name="hello", custom="val")
    k = rec.keys()
    assert "id" in k
    assert "name" in k
    assert "custom" in k
