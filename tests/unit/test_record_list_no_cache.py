"""Tests for RecordList — cache removal, ListMode behavior, factories."""

from __future__ import annotations

from unittest.mock import MagicMock, patch, PropertyMock

import pytest

from flow_sdk.fs_store.record_list import RecordList, ListMode
from flow_sdk.fs_store.exceptions import ReadOnlyProviderError


def _make_mock_record(uid: str = "r1", record_type: str = "test"):
    rec = MagicMock()
    rec.id = uid
    rec.type = record_type
    return rec


def _make_record_class(records: list | None = None):
    cls = MagicMock()
    cls.discover = MagicMock(return_value=records or [])
    cls.discover_one = MagicMock(return_value=None)
    cls.from_dict = MagicMock(side_effect=lambda d: _make_mock_record(d.get("uid", "new")))
    return cls


class TestMutableMode:
    def test_iter_calls_discover_each_time(self):
        """MUTABLE mode: every iteration triggers a fresh discover()."""
        r1 = _make_mock_record("r1")
        cls = _make_record_class([r1])
        rl = RecordList(cls)
        # Use iter() directly to avoid __len__ pre-allocation call
        _ = [x for x in rl.__iter__()]
        assert cls.discover.call_count == 1
        _ = [x for x in rl.__iter__()]
        assert cls.discover.call_count == 2

    def test_len_calls_discover_each_time(self):
        r1 = _make_mock_record("r1")
        cls = _make_record_class([r1])
        rl = RecordList(cls)
        len(rl)
        len(rl)
        assert cls.discover.call_count == 2


class TestImmutableWindow:
    def test_invalidate_clears_immutable_window(self):
        r1 = _make_mock_record("r1")
        cls = _make_record_class([r1])
        rl = RecordList(cls, mode=ListMode.IMMUTABLE_WINDOW)
        # First access caches
        _ = [x for x in rl.__iter__()]
        assert cls.discover.call_count == 1
        # Second access uses cache
        _ = [x for x in rl.__iter__()]
        assert cls.discover.call_count == 1
        # After invalidate, re-discovers
        rl.invalidate()
        _ = [x for x in rl.__iter__()]
        assert cls.discover.call_count == 2


class TestSnapshot:
    def test_snapshot_frozen_after_first_access(self):
        r1 = _make_mock_record("r1")
        cls = _make_record_class([r1])
        rl = RecordList(cls, mode=ListMode.SNAPSHOT)
        _ = [x for x in rl.__iter__()]
        rl.invalidate()  # no-op for SNAPSHOT
        _ = [x for x in rl.__iter__()]
        assert cls.discover.call_count == 1


class TestChildrenOf:
    def test_children_of_uses_children_refs(self):
        c1 = _make_mock_record("c1")
        c2 = _make_mock_record("c2")
        parent = MagicMock()
        parent.children = [c1, c2]
        rl = RecordList.children_of(parent)
        result = list(rl)
        assert len(result) == 2
        assert result[0].id == "c1"
        assert result[1].id == "c2"

    def test_children_of_with_type(self):
        c1 = _make_mock_record("c1", "task")
        parent = MagicMock()
        parent.get_children_by_type = MagicMock(return_value=[c1])
        rl = RecordList.children_of(parent, child_type="task")
        result = [x for x in rl.__iter__()]
        assert len(result) == 1
        parent.get_children_by_type.assert_called_with("task")


class TestRootFactory:
    def test_root_factory(self):
        cls = _make_record_class([])
        rl = RecordList.root(cls)
        assert rl.record_class is cls
        assert rl._mode == ListMode.MUTABLE


class TestLastChangedAt:
    def test_last_changed_at_from_provider(self):
        provider = MagicMock()
        provider.last_changed_at = 12345.0
        cls = _make_record_class()
        rl = RecordList(cls, provider=provider)
        assert rl.last_changed_at == 12345.0

    def test_last_changed_at_none_initially(self):
        cls = _make_record_class()
        rl = RecordList(cls)
        assert rl.last_changed_at is None


class TestSave:
    def test_save_delegates_to_provider_write_back(self):
        provider = MagicMock()
        provider.is_mutable = True
        provider.write_back = MagicMock()
        cls = _make_record_class()
        rl = RecordList(cls, provider=provider)
        rec = _make_mock_record("r1")
        rl.save(rec)
        provider.write_back.assert_called_once_with(rec)

    def test_save_raises_on_readonly_provider(self):
        provider = MagicMock()
        provider.is_mutable = False
        cls = _make_record_class()
        rl = RecordList(cls, provider=provider)
        rec = _make_mock_record("r1")
        with pytest.raises(ReadOnlyProviderError):
            rl.save(rec)

    def test_save_without_provider_calls_persist(self):
        cls = _make_record_class()
        rl = RecordList(cls)
        rec = _make_mock_record("r1")
        rl.save(rec)
        rec.persist.assert_called_once()
