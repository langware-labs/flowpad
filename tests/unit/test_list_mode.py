"""Tests for ListMode cache behavior (submodule 9)."""

from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest

from flow_sdk.fs_store.exceptions import ReadOnlyProviderError, ReadOnlyRecordError
from flow_sdk.fs_store.record_list import ListMode, RecordList


def _make_record(uid: str) -> MagicMock:
    r = MagicMock()
    r.id = uid
    return r


def _make_record_class(records: list):
    """Create a mock record class whose discover() returns records."""
    cls = MagicMock()
    cls.discover.return_value = records
    cls.discover_one.return_value = None
    cls._record_type = "test"
    return cls


def _iter_records(rl):
    """Iterate without triggering __len__ (which list() does for pre-alloc)."""
    return [r for r in rl.__iter__()]


class TestMutableMode:
    def test_mutable_always_discovers(self):
        r1 = _make_record("a")
        cls = _make_record_class([r1])

        rl = RecordList(cls, mode=ListMode.MUTABLE)
        _iter_records(rl)
        _iter_records(rl)

        assert cls.discover.call_count == 2


class TestImmutableWindowMode:
    def test_immutable_window_caches(self):
        r1 = _make_record("a")
        cls = _make_record_class([r1])

        rl = RecordList(cls, mode=ListMode.IMMUTABLE_WINDOW)
        _iter_records(rl)
        _iter_records(rl)

        assert cls.discover.call_count == 1

    def test_immutable_window_invalidate(self):
        r1 = _make_record("a")
        cls = _make_record_class([r1])

        rl = RecordList(cls, mode=ListMode.IMMUTABLE_WINDOW)
        _iter_records(rl)
        assert cls.discover.call_count == 1

        rl.invalidate()
        _iter_records(rl)
        assert cls.discover.call_count == 2

    def test_immutable_window_ttl_expires(self):
        r1 = _make_record("a")
        cls = _make_record_class([r1])

        rl = RecordList(cls, mode=ListMode.IMMUTABLE_WINDOW, ttl_seconds=0.01)
        _iter_records(rl)
        assert cls.discover.call_count == 1

        time.sleep(0.02)
        _iter_records(rl)
        assert cls.discover.call_count == 2


class TestSnapshotMode:
    def test_snapshot_frozen(self):
        r1 = _make_record("a")
        cls = _make_record_class([r1])

        rl = RecordList(cls, mode=ListMode.SNAPSHOT)
        _iter_records(rl)
        rl.invalidate()  # Should be no-op for SNAPSHOT
        _iter_records(rl)

        assert cls.discover.call_count == 1

    def test_snapshot_lazy_not_eager(self):
        r1 = _make_record("a")
        cls = _make_record_class([r1])

        rl = RecordList(cls, mode=ListMode.SNAPSHOT)
        # No discover call yet
        assert cls.discover.call_count == 0

        # First iteration triggers discover
        _iter_records(rl)
        assert cls.discover.call_count == 1


class TestSaveMutability:
    def test_save_checks_provider_mutable(self):
        from flow_sdk.fs_store.provider import FSProvider, GmailProvider

        record = MagicMock()

        # FSProvider is mutable — save should work
        fs = FSProvider()
        cls = _make_record_class([])
        rl_fs = RecordList(cls, provider=fs)
        rl_fs.save(record)
        record.persist.assert_called_once()

        # GmailProvider is read-only — save should raise
        gmail = GmailProvider()
        rl_gmail = RecordList(cls, provider=gmail)
        with pytest.raises(ReadOnlyProviderError):
            rl_gmail.save(record)


class TestReadOnlyProviderErrorClass:
    def test_readonly_provider_error_is_sibling_not_subclass(self):
        assert not issubclass(ReadOnlyProviderError, ReadOnlyRecordError)
        assert not issubclass(ReadOnlyRecordError, ReadOnlyProviderError)
        assert issubclass(ReadOnlyProviderError, Exception)
        assert issubclass(ReadOnlyRecordError, Exception)
