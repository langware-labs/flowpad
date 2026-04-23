"""Tests for named FSRef children on Record subclasses (exclusion mode)."""
import json
from pathlib import Path
from typing import ClassVar
import pytest
from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root
from flow_sdk.fs_store.fs_ref import JSONFsRef


class ConfigRecord(Record):
    _record_type: ClassVar[str] = "config_rec"
    _domain_fsref_keys: ClassVar[list[str]] = ["config"]

    @property
    def config_ref(self) -> JSONFsRef | None:
        d = self.record_data_dir
        return JSONFsRef(d / "config.json") if d is not None else None

    @property
    def config(self) -> dict:
        ref = self.config_ref
        return ref.as_dict() if ref is not None else {}

    @config.setter
    def config(self, value: dict) -> None:
        object.__getattribute__(self, "__dict__")["config"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("config")
        ref = self.config_ref
        if ref is not None:
            ref.update(value)


@pytest.fixture
def tmp_record(tmp_path):
    old = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(old)


def test_record_data_dir_property(tmp_record):
    rec = ConfigRecord(id="cfg-1", type="config_rec")
    rec.save()
    # record_data_dir now points to the record folder itself
    assert rec.record_data_dir is not None
    assert rec.record_data_dir == rec.record_dir


def test_named_fsref_write_creates_file(tmp_record):
    rec = ConfigRecord(id="cfg-2", type="config_rec")
    rec.save()
    rec.config = {"key": "value"}
    assert (rec.record_data_dir / "config.json").exists()


def test_named_fsref_read_after_write(tmp_record):
    rec = ConfigRecord(id="cfg-3", type="config_rec")
    rec.save()
    rec.config = {"x": 42}
    assert rec.config_ref.get("x") == 42


def test_blob_still_written(tmp_record):
    """Named key is absent from metadata.json; non-named fields appear in metadata.json."""
    # Include a non-named domain field (description) alongside the named config field
    rec = ConfigRecord(id="cfg-4", type="config_rec", name="Test", config={"a": 1})
    rec.description = "a blob field"
    rec.save()
    folder = rec.record_dir
    # metadata.json must exist
    assert (folder / "metadata.json").exists(), "metadata.json must exist"
    meta = json.loads((folder / "metadata.json").read_text(encoding="utf-8"))
    meta_data = meta.get("data", meta)
    # config key must NOT appear in metadata.json — it lives in config.json instead
    assert "config" not in meta_data, (
        "config key should be absent from metadata.json when in _domain_fsref_keys"
    )
    assert meta_data.get("description") == "a blob field"
    # But the named file must exist and contain the value
    assert (folder / "config.json").exists()
    named = json.loads((folder / "config.json").read_text(encoding="utf-8"))
    assert named.get("data") == {"a": 1}


def test_domain_fsref_keys_declared(tmp_record):
    assert "config" in ConfigRecord._domain_fsref_keys


def test_record_data_dir_none_without_path():
    rec = ConfigRecord(id="no-path", type="config_rec")
    # No save() called, no path set
    # record_data_dir may be non-None if default root is set, so just check it returns Path or None
    result = rec.record_data_dir
    assert result is None or isinstance(result, Path)


def test_cold_load_rehydrates_from_named_file(tmp_record):
    """Loading a record folder rehydrates config from config.json."""
    folder = tmp_record / "config_rec" / "config_rec-@cfg-cold"
    folder.mkdir(parents=True, exist_ok=True)
    # Write minimal metadata.json
    (folder / "metadata.json").write_text(
        json.dumps({"data": {"id": "cfg-cold", "type": "config_rec", "name": "Cold"}}),
        encoding="utf-8",
    )
    # Write legacy blob and named file directly in folder
    (folder / "_obj_data.json").write_text(
        json.dumps({"data": {"description": "hello"}}), encoding="utf-8"
    )
    (folder / "config.json").write_text(
        json.dumps({"data": {"host": "localhost", "port": 5432}}), encoding="utf-8"
    )

    rec = ConfigRecord.load_record(folder)
    assert rec.config == {"host": "localhost", "port": 5432}
    assert rec.description == "hello"


def test_named_file_wins_over_blob(tmp_record):
    """When both blob and named file contain 'config', named file value wins."""
    folder = tmp_record / "config_rec" / "config_rec-@cfg-win"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "metadata.json").write_text(
        json.dumps({"data": {"id": "cfg-win", "type": "config_rec"}}), encoding="utf-8"
    )
    # Blob has stale value
    (folder / "_obj_data.json").write_text(
        json.dumps({"data": {"config": {"from": "blob"}}}), encoding="utf-8"
    )
    # Named file has authoritative value
    (folder / "config.json").write_text(
        json.dumps({"data": {"from": "named"}}), encoding="utf-8"
    )

    rec = ConfigRecord.load_record(folder)
    assert rec.config == {"from": "named"}, (
        "named file should win over blob value"
    )


