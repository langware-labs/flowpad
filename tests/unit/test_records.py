"""Comprehensive unit tests for the Record / PropertyRecord / RecordState system.

Covers:
- Basic Record construction (with/without meta, kwargs, _data round-trip)
- PropertyRecord descriptor protocol (__set_name__, __get__, TTL, list_key)
- RecordState load/save, round-trip, corrupted JSON, missing paths
- Record.discovery() — first-time, cached, force, recursive
- Record.get_prop() — first access, cached, TTL expiry, fallback to _data
- ttl=-1 (never auto-expires)
- Bad data_refs, nonexistent paths, read-only records (no state.json written)
- PropertyRecord subclass with overridden run_discovery
- list_key storage and retrieval
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import ClassVar
from unittest.mock import patch

import pytest

from flow_sdk.fs_store import Record, PropertyRecord, RecordState, RecordStatus
from flow_sdk.fs_store.record import _DATA_JSON, set_default_records_root


# ── Helpers / fixtures ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def isolated_records_root(tmp_path):
    """Each test gets its own records root so default_path doesn't bleed over."""
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(Path.home() / ".flow" / "records")


def make_record_dir(tmp_path: Path, record_type: str = "test", uid: str = "abc") -> Path:
    """Create a minimal record folder with data.json."""
    folder = tmp_path / record_type / f"{record_type}-@{uid}"
    folder.mkdir(parents=True)
    (folder / _DATA_JSON).write_text(
        json.dumps({"data": {"id": uid, "type": record_type, "name": "Test"}}),
        encoding="utf-8",
    )
    return folder


# ── Simple PropertyRecord descriptors for testing ────────────────────────────


class ConstantProp(PropertyRecord):
    """Always returns a fixed value."""
    _record_type = "prop_constant"
    _default_ttl = 60

    def __init__(self, value, **kwargs):
        super().__init__(**kwargs)
        self._const_value = value

    def run_discovery(self, instance, force=False):
        return self._const_value


class CountingProp(PropertyRecord):
    """Counts how many times discovery was run."""
    _record_type = "prop_counting"
    _default_ttl = 60

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.call_count = 0

    def run_discovery(self, instance, force=False):
        self.call_count += 1
        return self.call_count


class AlwaysErrorProp(PropertyRecord):
    """Raises during discovery — should be handled gracefully by callers."""
    _record_type = "prop_always_error"
    _default_ttl = 60

    def run_discovery(self, instance, force=False):
        raise RuntimeError("discovery exploded")


class ListProp(PropertyRecord):
    """Returns a list value with list_key='items'."""
    _record_type = "prop_list"
    _default_ttl = 60

    def run_discovery(self, instance, force=False):
        return ["a", "b", "c"]


class NeverExpiresProp(PropertyRecord):
    """ttl=-1 — never auto-invalidates on get_prop."""
    _record_type = "prop_never_expires"
    _default_ttl = -1

    def run_discovery(self, instance, force=False):
        return "computed-once"


# ── Record subclasses under test ──────────────────────────────────────────────


class WidgetRecord(Record):
    """A simple record with two registered PropertyRecord descriptors."""
    _record_type = "widget"

    label = ConstantProp("hello")
    count = CountingProp()
    tags = ListProp(list_key="items")
    permanent = NeverExpiresProp()


class ReadOnlyWidget(Record):
    _record_type = "ro_widget"

    def __init__(self, **kwargs):
        kwargs.setdefault("type", "ro_widget")
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    label = ConstantProp("ro-label")


class ChildWidget(WidgetRecord):
    """Inherits parent's properties and adds its own."""
    _record_type = "child_widget"

    extra = ConstantProp("extra-val")


# ═══════════════════════════════════════════════════════════════════════════════
# 1. Basic Record construction
# ═══════════════════════════════════════════════════════════════════════════════


def test_record_empty_construction():
    r = Record()
    assert r.id  # auto UUID
    assert r.type == ""
    assert r.name == ""


def test_record_kwargs():
    r = Record(name="foo", status="active", custom_field="bar")
    assert r.name == "foo"
    assert r.status == "active"
    assert r.data["custom_field"] == "bar"


def test_record_type_from_class():
    w = WidgetRecord()
    assert w.type == "widget"


def test_record_from_dict_round_trip():
    r = Record(name="hello", status="new")
    d = r.to_dict()
    r2 = Record.from_dict(d)
    assert r2.name == "hello"
    assert r2.id == r.id


def test_record_no_meta_fields_bleed(tmp_path):
    """Old meta fields (created_at etc.) should not appear in domain data."""
    folder = make_record_dir(tmp_path)
    r = Record.load_record(folder / _DATA_JSON)
    assert "created_at" not in r.data
    assert "modified_at" not in r.data


def test_record_save_and_load(tmp_path):
    folder = tmp_path / "widget" / "widget-@x1"
    folder.mkdir(parents=True)
    r = WidgetRecord(id="x1", name="saved-widget")
    r.path = str(folder)
    r.source_file = str(folder / _DATA_JSON)
    r.save_record_json()

    r2 = WidgetRecord.load_record(folder / _DATA_JSON)
    assert r2.name == "saved-widget"
    assert r2.id == "x1"


# ═══════════════════════════════════════════════════════════════════════════════
# 2. PropertyRecord descriptor protocol
# ═══════════════════════════════════════════════════════════════════════════════


def test_set_name_auto_registers():
    """Descriptor.__set_name__ must register the prop in the class's _property_types."""
    assert "label" in WidgetRecord._property_types
    assert "count" in WidgetRecord._property_types
    assert "tags" in WidgetRecord._property_types
    assert "permanent" in WidgetRecord._property_types


def test_class_level_access_returns_descriptor():
    """Accessing a PropertyRecord on the class (not instance) returns the descriptor."""
    d = WidgetRecord.__dict__["label"]
    assert isinstance(d, PropertyRecord)
    # class-level __get__ returns self
    assert WidgetRecord.label is d


def test_descriptor_get_returns_value():
    w = WidgetRecord()
    assert w.label == "hello"


def test_descriptor_runs_discovery_on_first_access():
    calls = []

    class FreshRecord(Record):
        _record_type = "fresh_count_a"
        count = PropertyRecord(ttl=60, discovery=lambda r: (calls.append(1) or len(calls)))

    w = FreshRecord()
    assert w.count == 1
    # second access — not expired (ttl=60), so no re-run
    assert w.count == 1
    assert len(calls) == 1


def test_list_key_returns_list():
    w = WidgetRecord()
    result = w.tags
    assert isinstance(result, list)
    assert result == ["a", "b", "c"]


def test_never_expires_not_refreshed_on_access():
    w = WidgetRecord()
    _ = w.permanent  # first access → discovery runs
    # Force the entry to look "old" (pretend computed_at is ancient)
    idx = w._get_state()
    entry = idx.get_property("permanent")
    assert entry is not None
    entry["computed_at"] = "2000-01-01T00:00:00+00:00"
    idx.set_property("permanent", entry)
    # get_prop should NOT re-run because ttl=-1
    assert w.permanent == "computed-once"


def test_expired_prop_is_refreshed():
    calls = []

    class FreshRecord(Record):
        _record_type = "fresh_count_b"
        count = PropertyRecord(ttl=60, discovery=lambda r: (calls.append(1) or len(calls)))

    w = FreshRecord()
    _ = w.count  # run once → calls=[1], value=1
    assert len(calls) == 1

    # Force expiry
    idx = w._get_state()
    entry = idx.get_property("count")
    old_ts = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
    entry["computed_at"] = old_ts
    idx.set_property("count", entry)

    new_val = w.count  # expired → re-run → calls=[1,1], value=2
    assert new_val == 2
    assert len(calls) == 2


def test_fallback_to_data_when_no_descriptor():
    r = Record(my_field="data-value")
    # No PropertyRecord registered for "my_field"
    assert r.get_prop("my_field") == "data-value"


def test_fallback_returns_none_for_unknown_key():
    r = Record()
    assert r.get_prop("totally_unknown") is None


# ═══════════════════════════════════════════════════════════════════════════════
# 3. Child class inherits parent descriptors
# ═══════════════════════════════════════════════════════════════════════════════


def test_child_inherits_parent_properties():
    c = ChildWidget()
    assert c.label == "hello"
    assert c.extra == "extra-val"


def test_child_has_own_property_types_dict():
    """Child gets its own _property_types so parent isn't mutated."""
    assert "extra" in ChildWidget._property_types
    assert "extra" not in WidgetRecord._property_types


# ═══════════════════════════════════════════════════════════════════════════════
# 4. RecordState: load / save / round-trip
# ═══════════════════════════════════════════════════════════════════════════════


def test_record_state_no_path_no_save():
    """Record without explicit path → _state_path() resolves to records_root shadow."""
    r = WidgetRecord()
    idx = r._get_state()
    idx.mark_discovered()
    # save() should not raise — it writes to records_root shadow folder
    idx.save()
    # _state_path() now always resolves via metadata_ref (records_root), not None
    assert idx._state_path() is not None


def test_record_state_saves_and_loads(tmp_path):
    folder = make_record_dir(tmp_path)
    r = WidgetRecord()
    r.path = str(folder)

    idx = RecordState(r)
    idx.mark_discovered()
    idx.set_property("label", {"value": "stored", "type": "prop_constant",
                                "ttl": 60, "discovered_at": datetime.now(timezone.utc).isoformat()})
    idx.save()

    # Load in fresh state
    idx2 = RecordState(r)
    idx2.load()
    assert idx2.is_discovered()
    assert idx2.get_property("label")["value"] == "stored"


def test_record_state_corrupted_json(tmp_path):
    folder = make_record_dir(tmp_path)
    state_path = folder / "state.json"
    state_path.write_text("{corrupt json{{", encoding="utf-8")

    r = WidgetRecord()
    r.path = str(folder)
    idx = RecordState(r)
    idx.load()  # should silently ignore
    assert not idx.is_discovered()
    assert idx.get_property("label") is None


def test_record_state_missing_file(tmp_path):
    folder = make_record_dir(tmp_path)
    r = WidgetRecord()
    r.path = str(folder)
    idx = RecordState(r)
    idx.load()  # no state.json present → no-op
    assert not idx.is_discovered()


def test_record_state_no_fields_key(tmp_path):
    """state.json with no 'fields' key → treated as empty, not discovered."""
    folder = make_record_dir(tmp_path)
    (folder / "state.json").write_text(
        json.dumps({"meta": {"id": "x"}}),
        encoding="utf-8",
    )
    r = WidgetRecord()
    r.path = str(folder)
    idx = RecordState(r)
    idx.load()
    assert not idx.is_discovered()
    assert idx.get_property("label") is None


def test_record_state_file_layout(tmp_path):
    """FILE layout: source_file is a .json → state.json goes to records_root shadow,
    NOT next to the source .json file."""
    folder = make_record_dir(tmp_path)
    r = WidgetRecord(id="abc")
    r.source_file = str(folder / _DATA_JSON)
    # No path set; _state_path() resolves via metadata_ref → records_root
    idx = RecordState(r)
    from flow_sdk.fs_store.record import get_default_records_root
    expected = get_default_records_root() / "widget" / "widget-@abc" / "state.json"
    assert idx._state_path() == expected
    # Negative: state must NOT resolve to the source file's directory
    assert idx._state_path() != folder / "state.json", \
        "state.json must not resolve next to the source .json file"


def test_record_state_list_key_round_trip(tmp_path):
    folder = make_record_dir(tmp_path)
    r = WidgetRecord()
    r.path = str(folder)

    idx = RecordState(r)
    descriptor = WidgetRecord.__dict__["tags"]
    value = ["x", "y"]
    entry = descriptor.to_index_entry(value)
    idx.set_property("tags", entry)
    idx.mark_discovered()
    idx.save()

    idx2 = RecordState(r)
    idx2.load()
    stored = idx2.get_property("tags")
    assert descriptor.get_value(stored) == ["x", "y"]


# ═══════════════════════════════════════════════════════════════════════════════
# 5. Record.discovery() lifecycle
# ═══════════════════════════════════════════════════════════════════════════════


def test_discovery_first_time_runs_all_props(tmp_path):
    folder = make_record_dir(tmp_path)
    w = WidgetRecord(id="abc", name="Test")
    w.path = str(folder)
    w.source_file = str(folder / _DATA_JSON)

    w.discovery()

    idx = w._get_state()
    assert idx.is_discovered()
    assert idx.get_property("label") is not None
    assert idx.get_property("count") is not None


def test_discovery_writes_state_json(tmp_path):
    folder = make_record_dir(tmp_path, record_type="widget", uid="abc")
    w = WidgetRecord(id="abc", name="Test")
    w.path = str(folder)
    w.source_file = str(folder / _DATA_JSON)

    w.discovery()
    # state.json now goes to records_root shadow folder (not next to source_file)
    from flow_sdk.fs_store.record import get_default_records_root
    state_path = get_default_records_root() / "widget" / "widget-@abc" / "state.json"
    assert state_path.exists()
    # Verify state.json is NOT written next to source_file
    assert not (folder / "state.json").exists(), \
        "state.json must not be written next to source_file"


def test_discovery_force_false_skips_data_reload(tmp_path):
    folder = make_record_dir(tmp_path)
    w = WidgetRecord(id="abc", name="Test")
    w.path = str(folder)
    w.source_file = str(folder / _DATA_JSON)

    w.discovery()  # first run
    w.name = "in-memory-only"

    # force=False → data.json NOT reloaded; in-memory value survives
    w.discovery(force=False)
    assert w.data["name"] == "in-memory-only"


def test_discovery_force_true_reloads_data(tmp_path):
    folder = make_record_dir(tmp_path)
    w = WidgetRecord(id="abc", name="Test")
    w.path = str(folder)
    w.source_file = str(folder / _DATA_JSON)

    w.discovery()
    w.name = "in-memory-only"

    # force=True → data.json IS reloaded; in-memory value overwritten
    w.discovery(force=True)
    assert w.data["name"] == "Test"


def test_discovery_force_false_reruns_expired_props(tmp_path):
    folder = make_record_dir(tmp_path)
    calls = []

    class FreshRecord(Record):
        _record_type = "fresh_count_c"
        count = PropertyRecord(ttl=60, discovery=lambda r: (calls.append(1) or len(calls)))

    w = FreshRecord(id="abc")
    w.path = str(folder)
    w.source_file = str(folder / _DATA_JSON)
    w.discovery()  # count→1
    assert len(calls) == 1

    # Expire the count entry
    idx = w._get_state()
    entry = idx.get_property("count")
    old_ts = (datetime.now(timezone.utc) - timedelta(seconds=200)).isoformat()
    entry["computed_at"] = old_ts
    idx.set_property("count", entry)

    w.discovery(force=False)  # count should re-run
    assert len(calls) == 2
    assert idx.get_property("count")["value"] == 2


def test_discovery_returns_self(tmp_path):
    folder = make_record_dir(tmp_path)
    w = WidgetRecord(id="abc")
    w.path = str(folder)
    w.source_file = str(folder / _DATA_JSON)
    assert w.discovery() is w


def test_discovery_recursive(tmp_path):
    """discovery(recursive=True) propagates to children loaded from disk."""
    # Create parent + child folders with correct record_type so type is not overwritten
    parent_folder = make_record_dir(tmp_path, record_type="widget", uid="parent")
    child_folder = make_record_dir(tmp_path, record_type="widget", uid="child")

    parent = WidgetRecord(id="parent")
    parent.path = str(parent_folder)
    parent.source_file = str(parent_folder / _DATA_JSON)
    parent.add_child_ref = None  # not testing add_child specifically here

    child = WidgetRecord(id="child")
    child.path = str(child_folder)
    child.source_file = str(child_folder / _DATA_JSON)

    from flow_sdk.fs_store.record_ref import RecordRef
    parent.children_refs = [RecordRef(id="child", type="widget", path=str(child_folder))]

    parent.discovery(recursive=True)

    # Child's state.json now goes to records_root shadow folder (not next to source_file)
    from flow_sdk.fs_store.record import get_default_records_root
    child_state = get_default_records_root() / "widget" / "widget-@child" / "state.json"
    assert child_state.exists()
    assert not (child_folder / "state.json").exists(), \
        "state.json must not be written next to source_file"


# ═══════════════════════════════════════════════════════════════════════════════
# 6. TTL=-1 behaviour
# ═══════════════════════════════════════════════════════════════════════════════


def test_ttl_minus1_never_expires():
    w = WidgetRecord()
    descriptor = WidgetRecord.__dict__["permanent"]
    entry = {"value": "v", "discovered_at": "2000-01-01T00:00:00+00:00",
             "type": "prop_never_expires", "ttl": -1}
    assert descriptor.is_expired(entry) is False


def test_ttl_minus1_discovery_only_once_via_get_prop():
    nep = WidgetRecord.__dict__["permanent"]
    w = WidgetRecord()
    _ = w.permanent  # first access triggers discovery

    # Manually corrupt the stored value to verify it doesn't get re-run
    idx = w._get_state()
    idx.get_property("permanent")["value"] = "corrupted"
    assert w.permanent == "corrupted"  # not refreshed


# ═══════════════════════════════════════════════════════════════════════════════
# 7. Read-only record — state.json silently skipped
# ═══════════════════════════════════════════════════════════════════════════════


def test_read_only_no_index_written(tmp_path):
    folder = tmp_path / "ro"
    folder.mkdir()
    r = ReadOnlyWidget()
    r.source_file = str(folder / "data.jsonl")  # no folder path → no index path
    # discovery should not raise even though we can't write
    r.discovery()
    assert not (folder / "state.json").exists()


def test_read_only_get_prop_works():
    r = ReadOnlyWidget()
    assert r.label == "ro-label"  # property still computes; just doesn't persist


# ═══════════════════════════════════════════════════════════════════════════════
# 8. Corrupted / missing data refs
# ═══════════════════════════════════════════════════════════════════════════════


def test_reload_from_disk_nonexistent_path():
    """_reload_from_disk with a path that doesn't exist is silent."""
    r = Record()
    r.source_file = "/totally/nonexistent/data.json"
    r._reload_from_disk()  # should not raise


def test_reload_from_disk_corrupt_json(tmp_path):
    bad = tmp_path / "data.json"
    bad.write_text("{bad json", encoding="utf-8")
    r = Record()
    r.source_file = str(bad)
    r._reload_from_disk()  # should not raise


def test_discovery_missing_source_still_marks_discovered(tmp_path):
    """Even if source_file doesn't exist, discovery marks the record discovered."""
    folder = make_record_dir(tmp_path)
    r = WidgetRecord()
    r.path = str(folder)
    r.source_file = "/does/not/exist/data.json"
    r.discovery()
    assert r._get_state().is_discovered()


# ═══════════════════════════════════════════════════════════════════════════════
# 9. PropertyRecord.to_index_entry / get_value round-trip
# ═══════════════════════════════════════════════════════════════════════════════


def test_scalar_entry_round_trip():
    d = ConstantProp("xyz")
    d._name = "label"
    entry = d.to_index_entry("xyz")
    assert entry["value"] == "xyz"
    assert entry["type"] == "prop_constant"
    assert entry["ttl"] == 60
    assert "computed_at" in entry
    assert d.get_value(entry) == "xyz"


def test_list_key_entry_round_trip():
    d = ListProp(list_key="items")
    d._name = "tags"
    entry = d.to_index_entry(["a", "b"])
    assert "items" in entry
    assert "value" not in entry
    assert d.get_value(entry) == ["a", "b"]


def test_list_key_missing_from_entry_returns_default():
    d = ListProp(list_key="items")
    d._name = "tags"
    # Entry without the list_key stored
    entry = {"type": "prop_list", "ttl": 60, "computed_at": "2025-01-01T00:00:00+00:00"}
    assert d.get_value(entry) == []


def test_list_key_non_list_coerced_to_empty():
    d = ListProp(list_key="items")
    d._name = "tags"
    entry = d.to_index_entry("not-a-list")
    assert entry["items"] == []


def test_scalar_default_when_no_value():
    d = PropertyRecord(ttl=60, default="default-val")
    d._name = "x"
    entry = {"type": "property", "ttl": 60, "discovered_at": "2025-01-01T00:00:00+00:00"}
    # No "value" key → falls back to self._default
    assert d.get_value(entry) == "default-val"


# ═══════════════════════════════════════════════════════════════════════════════
# 10. PropertyRecord TTL expiry arithmetic
# ═══════════════════════════════════════════════════════════════════════════════


def test_is_expired_no_discovered_at():
    d = ConstantProp("v")
    entry = {"type": "prop_constant", "ttl": 60}  # no discovered_at
    assert d.is_expired(entry) is True


def test_is_expired_fresh_entry():
    d = ConstantProp("v")
    entry = {"type": "prop_constant", "ttl": 60,
             "discovered_at": datetime.now(timezone.utc).isoformat()}
    assert d.is_expired(entry) is False


def test_is_expired_stale_entry():
    d = ConstantProp("v")
    old_ts = (datetime.now(timezone.utc) - timedelta(seconds=120)).isoformat()
    entry = {"type": "prop_constant", "ttl": 60, "discovered_at": old_ts}
    assert d.is_expired(entry) is True


def test_is_expired_ttl_minus1_never():
    d = NeverExpiresProp()
    old_entry = {"ttl": -1, "value": "v", "discovered_at": "2000-01-01T00:00:00+00:00"}
    assert d.is_expired(old_entry) is False


def test_is_expired_bad_discovered_at_string():
    d = ConstantProp("v")
    entry = {"ttl": 60, "discovered_at": "not-a-date"}
    assert d.is_expired(entry) is True


# ═══════════════════════════════════════════════════════════════════════════════
# 11. PropertyRecord inline discovery= callable
# ═══════════════════════════════════════════════════════════════════════════════


def test_inline_discovery_callable():
    calls = []

    class DynamicRecord(Record):
        _record_type = "dynamic"
        computed = PropertyRecord(ttl=60, discovery=lambda r: (calls.append(1) or 42))

    d = DynamicRecord()
    assert d.computed == 42
    assert len(calls) == 1


def test_inline_discovery_default_when_no_fn():
    class DefaultRecord(Record):
        _record_type = "default_rec"
        val = PropertyRecord(ttl=60, default="fallback")

    d = DefaultRecord()
    assert d.val == "fallback"


# ═══════════════════════════════════════════════════════════════════════════════
# 12. Stress: rapid repeated access, discovery calls, re-registration
# ═══════════════════════════════════════════════════════════════════════════════


def test_rapid_get_prop_no_excess_discovery_calls():
    """Accessing a fresh (non-expired) prop 100x should call discovery only once."""
    calls = []

    class FreshRecord(Record):
        _record_type = "fresh_count_d"
        val = PropertyRecord(ttl=300, discovery=lambda r: (calls.append(1) or len(calls)))

    w = FreshRecord()
    for _ in range(100):
        _ = w.val

    assert len(calls) == 1


def test_many_records_independent_state(tmp_path):
    """Each record instance has its own RecordState; they don't share state."""
    records = []
    for i in range(5):
        # Use correct record_type so type is not overwritten during _reload_from_disk
        f = make_record_dir(tmp_path, record_type="widget", uid=str(i))
        r = WidgetRecord(id=str(i), name=f"w{i}")
        r.path = str(f)
        r.source_file = str(f / _DATA_JSON)
        r.discovery()
        records.append(r)

    # Each should have its own state.json in the records_root shadow folder
    from flow_sdk.fs_store.record import get_default_records_root
    for i in range(5):
        state_path = get_default_records_root() / "widget" / f"widget-@{i}" / "state.json"
        assert state_path.exists()

    # Manually set different values via index
    for i, r in enumerate(records):
        idx = r._get_state()
        entry = idx.get_property("label")
        entry["value"] = f"custom-{i}"
        idx.set_property("label", entry)

    for i, r in enumerate(records):
        # get_prop reads from the in-memory index; no expiry (fresh entry)
        assert r.label == f"custom-{i}"


def test_discovery_idempotent_multiple_calls(tmp_path):
    folder = make_record_dir(tmp_path)
    calls = []

    class FreshRecord(Record):
        _record_type = "fresh_count_e"
        val = PropertyRecord(ttl=300, discovery=lambda r: (calls.append(1) or len(calls)))

    w = FreshRecord(id="abc")
    w.path = str(folder)
    w.source_file = str(folder / _DATA_JSON)

    for _ in range(5):
        w.discovery(force=False)

    # prop: discovered on first call, not expired on subsequent, so only called once
    assert len(calls) == 1


def test_discovery_force_true_reruns_every_time(tmp_path):
    folder = make_record_dir(tmp_path)
    calls = []

    class FreshRecord(Record):
        _record_type = "fresh_count_f"
        val = PropertyRecord(ttl=300, discovery=lambda r: (calls.append(1) or len(calls)))

    w = FreshRecord(id="abc")
    w.path = str(folder)
    w.source_file = str(folder / _DATA_JSON)

    for _ in range(3):
        w.discovery(force=True)

    assert len(calls) == 3
