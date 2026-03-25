"""Tests for the Record.fingerprint property (mtime+size based)."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, ClassVar

import pytest

from flow_sdk.fs_store.record import Record, set_default_records_root, get_default_records_root


class FPRecord(Record):
    _record_type: ClassVar[str] = "test_fp"

    @property
    def content(self) -> str | None:
        return getattr(self, "description", None)


@pytest.fixture
def tmp_record(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    rec = FPRecord(type="test_fp", id="fp-001", name="FP Test", description="Hello")
    rec.path = str(tmp_path / "test_fp" / "test_fp-@fp-001")
    rec.save()
    yield rec, tmp_path
    set_default_records_root(original)


class TestFingerprint:

    def test_fingerprint_no_files_returns_zeros(self, tmp_path):
        """A record with no files on disk returns all zeros."""
        original = get_default_records_root()
        set_default_records_root(tmp_path)
        try:
            rec = FPRecord(type="test_fp", id="no-files", name="Empty")
            # No path set, record_dir is None
            assert rec.fingerprint == "0" * 16
        finally:
            set_default_records_root(original)

    def test_fingerprint_stable_for_same_content(self, tmp_record):
        """Fingerprint is stable when files haven't changed."""
        rec, _ = tmp_record
        fp1 = rec.fingerprint
        fp2 = rec.fingerprint
        assert fp1 == fp2

    def test_fingerprint_changes_on_mtime_change(self, tmp_record):
        """Fingerprint changes when a file's mtime is updated."""
        rec, tmp_path = tmp_record
        fp_before = rec.fingerprint

        # Touch metadata.json to change mtime
        meta_path = rec.record_dir / "metadata.json"
        # Set mtime to a different value
        old_stat = meta_path.stat()
        os.utime(meta_path, (old_stat.st_atime, old_stat.st_mtime + 10))

        fp_after = rec.fingerprint
        assert fp_before != fp_after

    def test_fingerprint_changes_on_size_change(self, tmp_record):
        """Fingerprint changes when metadata.json size changes."""
        rec, tmp_path = tmp_record
        fp_before = rec.fingerprint

        # Modify metadata.json to change size
        meta_path = rec.record_dir / "metadata.json"
        current = json.loads(meta_path.read_text(encoding="utf-8"))
        current["data"]["extra_field"] = "x" * 100
        meta_path.write_text(json.dumps(current), encoding="utf-8")

        fp_after = rec.fingerprint
        assert fp_before != fp_after

    def test_fingerprint_16_hex_chars(self, tmp_record):
        """Fingerprint is exactly 16 hex characters."""
        rec, _ = tmp_record
        fp = rec.fingerprint
        assert len(fp) == 16
        int(fp, 16)  # validates hex
