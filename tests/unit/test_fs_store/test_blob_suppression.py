"""Tests for named FSRef children: no _obj_data.json blob, named files written, round-trip."""
from pathlib import Path
from typing import ClassVar
import json
import pytest
from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root
from flow_sdk.fs_store.fs_ref import JSONFsRef


class SuppressedRecord(Record):
    _record_type: ClassVar[str] = "suppressed"
    _domain_fsref_keys: ClassVar[list[str]] = ["settings"]

    @property
    def settings_ref(self) -> JSONFsRef | None:
        d = self.record_data_dir
        return JSONFsRef(d / "settings.json") if d is not None else None

    @property
    def settings(self) -> dict:
        return object.__getattribute__(self, "__dict__").get("settings", {})

    @settings.setter
    def settings(self, value: dict) -> None:
        object.__getattribute__(self, "__dict__")["settings"] = value
        object.__getattribute__(self, "_dirty_keys").add("settings")
        ref = self.settings_ref
        if ref is not None:
            ref.update(value)


@pytest.fixture
def tmp_rec(tmp_path):
    old = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(old)


def test_no_blob_written_when_suppressed(tmp_rec):
    rec = SuppressedRecord(id="s1", type="suppressed", settings={"k": "v"})
    rec.save()
    data_dir = rec.record_data_dir
    assert not (data_dir / "_obj_data.json").exists()


def test_named_file_written_when_suppressed(tmp_rec):
    rec = SuppressedRecord(id="s2", type="suppressed")
    rec.save()  # establish path first so settings_ref is not None
    rec.settings = {"x": 1}  # setter writes settings.json side-effect
    assert (rec.record_data_dir / "settings.json").exists()


def test_round_trip_with_blob_suppressed(tmp_rec, tmp_path):
    rec = SuppressedRecord(id="s3", type="suppressed", name="Test", settings={"a": "b"})
    rec.save()
    folder = Path(rec.path)
    from flow_sdk.fs_store.record import Record as _R
    reloaded = SuppressedRecord.load_record(folder)
    assert reloaded.settings == {"a": "b"}



def test_is_read_only_via_fsref(tmp_rec):
    """_is_read_only() returns True when asset_ref is read-only, even without ClassVar."""
    from flow_sdk.fs_store.fs_ref import FSRef

    class DynamicReadOnly(Record):
        _record_type: ClassVar[str] = "dro"

    rec = DynamicReadOnly(id="dro1", type="dro")
    rec.asset_ref = FSRef("/tmp/some_file.md", read_only=True)
    assert rec._is_read_only() is True


def test_is_read_only_false_without_flags(tmp_rec):
    rec = SuppressedRecord(id="s5", type="suppressed")
    assert rec._is_read_only() is False
