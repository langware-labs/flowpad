"""Unit tests for record hash sentinel mechanism."""

from __future__ import annotations

import time
from pathlib import Path

import pytest


@pytest.fixture
def tmp_record(tmp_path):
    """Create a Record instance with records_root isolated to tmp_path."""
    from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root

    old = get_default_records_root()
    set_default_records_root(tmp_path)
    rec = Record(type="test", id="abc123")
    rec.path = str(tmp_path / "test" / "test-@abc123")
    yield rec, rec.index_state_dir
    set_default_records_root(old)


def test_compute_record_hash_no_files(tmp_record):
    rec, state_dir = tmp_record
    h = rec.compute_record_hash()
    assert isinstance(h, str)
    assert len(h) == 16


def test_compute_record_hash_changes_with_content(tmp_record):
    rec, state_dir = tmp_record
    record_dir = Path(rec.path)
    record_dir.mkdir(parents=True, exist_ok=True)
    (record_dir / "metadata.json").write_text('{"id": "abc"}')
    h1 = rec.compute_record_hash()
    (record_dir / "metadata.json").write_text('{"id": "xyz"}')
    h2 = rec.compute_record_hash()
    assert h1 != h2
    assert len(h1) == len(h2) == 16


# --- Hash sentinel ---

def test_write_creates_hash_file(tmp_record):
    rec, state_dir = tmp_record
    rec.write_hash_file("deadbeef12345678")
    hash_files = list(state_dir.glob("*.hash"))
    assert len(hash_files) == 1
    stem = hash_files[0].stem
    parts = stem.split(".")
    assert len(parts) == 2
    assert parts[0] == "deadbeef12345678"
    int(parts[1])  # must be a parseable int timestamp


def test_write_removes_old_hash_files(tmp_record):
    rec, state_dir = tmp_record
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "oldhash.12345.hash").touch()
    rec.write_hash_file("newhash12345678")
    hash_files = list(state_dir.glob("*.hash"))
    assert len(hash_files) == 1
    assert "newhash12345678" in hash_files[0].name


def test_write_replaces_previous_hash_file(tmp_record):
    rec, state_dir = tmp_record
    rec.write_hash_file("aabbccdd11223344")
    rec.write_hash_file("1122334455667788")
    hash_files = list(state_dir.glob("*.hash"))
    assert len(hash_files) == 1
    assert "1122334455667788" in hash_files[0].name


def test_read_hash_file(tmp_record):
    rec, state_dir = tmp_record
    rec.write_hash_file("cafebabe12345678")
    result = rec.read_hash_file()
    assert result is not None
    stored_fp, ts = result
    assert stored_fp == "cafebabe12345678"
    assert abs(ts - time.time()) < 5.0


def test_read_returns_none_when_missing(tmp_record):
    rec, state_dir = tmp_record
    result = rec.read_hash_file()
    assert result is None


def test_record_update_required_uses_fingerprint(tmp_record):
    rec, state_dir = tmp_record
    fp = rec.fingerprint
    rec.write_hash_file(fp)
    assert rec.record_update_required(ttl=30.0) is False


def test_record_update_required_ttl_expired(tmp_record):
    rec, state_dir = tmp_record
    fp = rec.fingerprint
    state_dir.mkdir(parents=True, exist_ok=True)
    old_ts = int(time.time()) - 100
    (state_dir / f"{fp}.{old_ts}.hash").touch()
    assert rec.record_update_required(ttl=30.0) is True


def test_record_update_required_fingerprint_mismatch(tmp_record):
    rec, state_dir = tmp_record
    rec.write_hash_file("wrongfingerprint")
    assert rec.record_update_required(ttl=30.0) is True


def test_record_update_required_no_marker(tmp_record):
    rec, state_dir = tmp_record
    assert rec.record_update_required(ttl=30.0) is True


def test_write_hash_file_after_index(tmp_record):
    """write_hash_file writes .hash (not any other extension)."""
    rec, state_dir = tmp_record
    rec.write_hash_file(rec.fingerprint)
    assert len(list(state_dir.glob("*.hash"))) == 1
    assert len(list(state_dir.glob("*.synced"))) == 0


def test_record_update_required_no_record_dir(tmp_path):
    from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root

    old = get_default_records_root()
    set_default_records_root(tmp_path)
    try:
        rec = Record(type="test", id="abc123")
        # Fresh records_root has no hash file → update required
        assert rec.record_update_required(ttl=30.0) is True
    finally:
        set_default_records_root(old)
