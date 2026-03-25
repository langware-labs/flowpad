"""Tests for Record -- pure data contract: serialization, uid, key-value access, naming, children."""

import uuid
from datetime import datetime

import pytest

from flow_sdk.fs_store import RecordRef, Record, Scope
from flow_sdk.fs_store import parse_record_stem, record_stem


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class CloudRecord(Record):
    def __init__(self, **kwargs):
        if "entity_id" not in kwargs:
            kwargs["entity_id"] = f"cloud-{uuid.uuid4().hex[:6]}"
        super().__init__(**kwargs)


# ---------------------------------------------------------------------------
# id is the sole identity field
# ---------------------------------------------------------------------------

class TestRecordId:
    def test_id_is_set(self):
        r = Record(id="abc")
        assert r.id == "abc"

    def test_no_uid_property(self):
        r = Record(id="abc")
        assert not isinstance(getattr(type(r), "uid", None), property)

    def test_no_uid_field_name_classvar(self):
        assert not hasattr(Record, "uid_field_name")

    def test_id_auto_generated_uuid4(self):
        import uuid as _uuid
        r = Record()
        _uuid.UUID(r.id, version=4)  # raises if not valid uuid4


# ---------------------------------------------------------------------------
# Stem / naming convention
# ---------------------------------------------------------------------------

class TestStemNaming:
    def test_record_stem_format(self):
        assert record_stem("session", "abc123") == "session-@abc123"

    def test_parse_record_stem(self):
        typ, uid = parse_record_stem("rule-@def456")
        assert typ == "rule"
        assert uid == "def456"

    def test_parse_record_stem_with_extra_separator(self):
        typ, uid = parse_record_stem("my-type-@uid-with-dashes")
        assert typ == "my-type"
        assert uid == "uid-with-dashes"

    def test_parse_record_stem_invalid(self):
        with pytest.raises(ValueError):
            parse_record_stem("no_separator_here")

    def test_stem_property(self):
        r = Record(id="xyz", type="hook")
        assert r.stem == "hook-@xyz"

    def test_stem_uses_id(self):
        fixed_id = "eid-1"
        cr = CloudRecord(id=fixed_id, type="cloud")
        assert cr.stem == f"cloud-@{fixed_id}"


# ---------------------------------------------------------------------------
# Serialization: to_dict / from_dict
# ---------------------------------------------------------------------------

class TestSerialization:
    def test_to_dict_basic(self):
        r = Record(id="1", type="t", name="n")
        d = r.meta_dict()
        assert d["id"] == "1"
        assert d["type"] == "t"
        assert d["name"] == "n"
        assert "raw_json" not in d
        # Internal fields must be excluded
        assert "source_file" not in d
        assert "path" not in d
        assert "entity_id" not in d

    def test_to_dict_datetime_iso(self):
        dt = datetime(2025, 1, 15, 12, 0, 0)
        r = Record(created_at=dt)
        d = r.meta_dict()
        assert d["created_at"] == "2025-01-15T12:00:00"

    def test_to_dict_scope_enum_value(self):
        r = Record(scope=Scope.PROJECT)
        assert r.meta_dict()["scope"] == "project"

    def test_to_dict_raw_json_merged(self):
        r = Record(raw_json={"custom": 42})
        d = r.meta_dict()
        assert d["custom"] == 42
        assert "raw_json" not in d

    def test_from_dict_round_trip(self):
        r = Record(
            id="1", type="t", name="n",
            scope=Scope.PROJECT,
            raw_json={"tag": "v"},
        )
        d = r.meta_dict()
        r2 = Record.from_dict(d)
        assert r2.id == "1"
        assert r2["scope"] == Scope.PROJECT
        assert r2.raw_json["tag"] == "v"

    def test_from_dict_unknown_keys_to_raw_json(self):
        r = Record.from_dict({"name": "x", "foo": "bar", "baz": 1})
        assert r.name == "x"
        assert r.raw_json["foo"] == "bar"
        assert r.raw_json["baz"] == 1

    def test_from_dict_scope_coercion(self):
        r = Record.from_dict({"scope": "local"})
        assert r.scope == Scope.LOCAL

    def test_from_dict_scope_unknown_string(self):
        r = Record.from_dict({"scope": "custom_scope"})
        assert r.scope == "custom_scope"

    def test_subclass_from_dict(self):
        cr = CloudRecord.from_dict({"entity_id": "eid-9", "name": "svc"})
        assert cr.entity_id == "eid-9"
        assert cr.name == "svc"


# ---------------------------------------------------------------------------
# Key-value access
# ---------------------------------------------------------------------------

class TestKeyValueAccess:
    def test_getitem_known_field(self):
        r = Record(name="hello")
        assert r["name"] == "hello"

    def test_getitem_raw_json(self):
        r = Record(raw_json={"custom": 99})
        assert r["custom"] == 99

    def test_getitem_missing_raises(self):
        r = Record()
        with pytest.raises(KeyError):
            r["nonexistent"]

    def test_setitem_known_field(self):
        r = Record()
        r["name"] = "updated"
        assert r.name == "updated"

    def test_setitem_raw_json(self):
        r = Record()
        r["custom_key"] = "custom_val"
        assert r.raw_json["custom_key"] == "custom_val"

    def test_delitem(self):
        r = Record(raw_json={"k": "v"})
        del r["k"]
        assert "k" not in r.raw_json

    def test_delitem_known_field_raises(self):
        r = Record()
        with pytest.raises(KeyError):
            del r["name"]

    def test_contains_known(self):
        r = Record(name="test")
        assert "name" in r
        assert "id" in r

    def test_contains_raw_json(self):
        r = Record(raw_json={"tag": 1})
        assert "tag" in r
        assert "missing" not in r

    def test_keys(self):
        r = Record(name="n", raw_json={"x": 1, "y": 2})
        k = r.keys()
        assert "id" in k
        assert "name" in k
        assert "x" in k
        assert "y" in k
        assert "raw_json" not in k


# ---------------------------------------------------------------------------
# Children refs (RecordRef list)
# ---------------------------------------------------------------------------

class TestChildrenRefs:
    def test_no_children_by_default(self):
        r = Record()
        assert r.children_refs == []

    def test_add_children_refs(self):
        parent = Record(id="p", type="folder", name="parent")
        parent.children_refs = [
            RecordRef(id="c1", type="file"),
            RecordRef(id="c2", type="file"),
        ]
        assert len(parent.children_refs) == 2
        assert parent.children_refs[0].id == "c1"

    def test_to_dict_excludes_empty_children(self):
        r = Record(id="no-kids")
        d = r.meta_dict()
        assert "children" not in d

    def test_to_dict_includes_children(self):
        parent = Record(id="p", type="folder")
        parent.children_refs = [
            RecordRef(id="c1", type="file"),
            RecordRef(id="c2", type="file"),
        ]
        d = parent.meta_dict()
        assert "children" in d
        assert len(d["children"]) == 2
        assert d["children"][0]["id"] == "c1"

    def test_from_dict_with_children(self):
        data = {
            "id": "p",
            "type": "folder",
            "children": [
                {"id": "c1", "type": "file"},
                {"id": "c2", "type": "file"},
            ],
        }
        r = Record.from_dict(data)
        assert len(r.children_refs) == 2
        assert isinstance(r.children_refs[0], RecordRef)
        assert r.children_refs[0].id == "c1"

    def test_from_dict_no_children_key(self):
        r = Record.from_dict({"id": "solo"})
        assert r.children_refs == []

    def test_children_round_trip(self):
        parent = Record(id="p", type="folder", scope=Scope.PROJECT)
        parent.children_refs = [
            RecordRef(id="c1", type="file", path="/tmp/c1.json"),
        ]
        d = parent.meta_dict()
        r2 = Record.from_dict(d)
        assert len(r2.children_refs) == 1
        c = r2.children_refs[0]
        assert isinstance(c, RecordRef)
        assert c.id == "c1"
        assert c.path == "/tmp/c1.json"

    def test_children_refs_are_flat(self):
        """Children are RecordRef -- they don't embed full record data."""
        parent = Record(id="p", type="folder")
        parent.children_refs = [RecordRef(id="c", type="file")]
        d = parent.meta_dict()
        child_dict = d["children"][0]
        assert set(child_dict.keys()) == {"id", "type"}

    def test_children_with_path(self):
        ref = RecordRef(id="c", type="file", path="/data/c.json")
        parent = Record(id="p", children_refs=[ref])
        d = parent.meta_dict()
        assert d["children"][0]["path"] == "/data/c.json"


# ---------------------------------------------------------------------------
# Parent ref (RecordRef)
# ---------------------------------------------------------------------------

class TestParentRef:
    def test_parent_ref_defaults_to_none(self):
        r = Record()
        assert r.parent_ref is None

    def test_parent_ref_round_trip(self):
        r = Record(id="child-1", parent_ref=RecordRef(id="parent-1", type="task"))
        d = r.meta_dict()
        assert d["parent"] == {"id": "parent-1", "type": "task"}
        r2 = Record.from_dict(d)
        assert isinstance(r2.parent_ref, RecordRef)
        assert r2.parent_ref.id == "parent-1"
        assert r2.parent_ref.type == "task"

    def test_parent_ref_coexists_with_children_refs(self):
        r = Record(
            id="mid",
            type="node",
            parent_ref=RecordRef(id="root", type="root"),
            children_refs=[RecordRef(id="leaf", type="leaf")],
        )
        d = r.meta_dict()
        assert d["parent"]["id"] == "root"
        assert len(d["children"]) == 1
        r2 = Record.from_dict(d)
        assert r2.parent_ref.id == "root"
        assert r2.children_refs[0].id == "leaf"

    def test_backward_compat_parent_id_string(self):
        """Old serialized data with parent_id string should deserialize to RecordRef."""
        data = {"id": "child-1", "parent_id": "parent-1"}
        r = Record.from_dict(data)
        assert isinstance(r.parent_ref, RecordRef)
        assert r.parent_ref.id == "parent-1"
        assert r.parent_ref.type == ""


# ---------------------------------------------------------------------------
# Internal fields exclusion
# ---------------------------------------------------------------------------

class TestInternalFields:
    def test_to_dict_excludes_internal_fields(self):
        """source_file, path must never appear in serialized output."""
        r = Record(
            id="1", type="t", name="n",
            source_file="/tmp/rec.json",
            path="/tmp",
        )
        d = r.meta_dict()
        assert "source_file" not in d
        assert "path" not in d
        assert "raw_json" not in d
        assert "children_refs" not in d
        assert "parent_ref" not in d
        # Regular fields are still present
        assert d["id"] == "1"
        assert d["type"] == "t"

    def test_from_dict_preserves_internal_fields(self):
        """Round-trip: source_file and path survive from_dict."""
        data = {"id": "1", "type": "t", "source_file": "/tmp/rec.json",
                "path": "/tmp"}
        r2 = Record.from_dict(data)
        assert r2.source_file == "/tmp/rec.json"
        assert r2.path == "/tmp"


# ---------------------------------------------------------------------------
# Record alias
# ---------------------------------------------------------------------------

class TestRecordAlias:
    def test_record_alias(self):
        from flow_sdk.fs_store import Record
        from flow_sdk.fs_store.record import Record as NewRecord
        assert Record is NewRecord
