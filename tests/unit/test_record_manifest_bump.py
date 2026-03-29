"""Tests for Record.save() and Record.delete() manifest bump integration."""

from __future__ import annotations

import json
from pathlib import Path
from unittest import mock

import pytest

from flow_sdk.fs_store.record import Record, get_default_records_root, set_default_records_root, _DATA_JSON


@pytest.fixture()
def tmp_records_root(tmp_path):
    """Set up a temporary records root and restore after test."""
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


def _make_record(tmp_records_root: Path, record_type: str = "skill") -> Record:
    """Create a record under the default records root."""
    record = Record(id="test-rec-1", type=record_type, name="Test Record")
    record_dir = tmp_records_root / record_type / "test-rec-1"
    record_dir.mkdir(parents=True, exist_ok=True)
    record_file = record_dir / _DATA_JSON
    record.path = str(record_dir)
    record.source_file = str(record_file)
    record.save_record_json(record_file)
    return record


def test_save_new_record_bumps_add(tmp_records_root):
    """save() on a record with no source_file (first save) calls bump('add')."""
    record = Record(id="new-rec", type="skill", name="New Record")
    record_dir = tmp_records_root / "skill" / "new-rec"
    record_dir.mkdir(parents=True, exist_ok=True)
    # Don't set source_file — this is the new-record path
    with mock.patch("flow_sdk.fs_store.manifest.CollectionManifest") as MockManifest:
        mock_instance = MockManifest.return_value
        record.save()
        MockManifest.assert_called_once_with("skill")
        mock_instance.bump.assert_called_once_with("add")


def test_save_existing_record_bumps_update(tmp_records_root):
    """save() on an existing record (source_file already set) calls bump('update')."""
    record = _make_record(tmp_records_root)
    with mock.patch("flow_sdk.fs_store.manifest.CollectionManifest") as MockManifest:
        mock_instance = MockManifest.return_value
        record.save()
        MockManifest.assert_called_once_with("skill")
        mock_instance.bump.assert_called_once_with("update")


@pytest.mark.asyncio
async def test_delete_bumps_manifest(tmp_records_root):
    """delete() should call CollectionManifest.bump('remove')."""
    record = _make_record(tmp_records_root)
    with mock.patch("flow_sdk.fs_store.manifest.CollectionManifest") as MockManifest:
        mock_instance = MockManifest.return_value
        await record.delete()
        MockManifest.assert_called_once_with("skill")
        mock_instance.bump.assert_called_once_with("remove")


def test_save_outside_records_root_no_bump(tmp_records_root, tmp_path):
    """save() should NOT bump manifest for records outside records root."""
    record = Record(id="test-rec-2", type="skill", name="Outside Record")
    other_dir = tmp_path / "other" / "skill" / "test-rec-2"
    other_dir.mkdir(parents=True, exist_ok=True)
    record_file = other_dir / _DATA_JSON
    record.path = str(other_dir)
    record.source_file = str(record_file)
    record.save_record_json(record_file)

    with mock.patch("flow_sdk.fs_store.manifest.CollectionManifest.bump") as mock_bump:
        record.save()
        mock_bump.assert_not_called()


@pytest.mark.asyncio
async def test_delete_removes_record(tmp_records_root):
    """delete() should remove the record from disk."""
    record = _make_record(tmp_records_root)
    record_dir = Path(record.path)
    assert record_dir.exists()
    await record.delete()
    assert not record_dir.exists()
    assert record.source_file is None
