"""Tests for FSProvider (submodule 8)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from flow_sdk.fs_store.provider import FSProvider
from flow_sdk.fs_store.record_query import RecordQuery


class TestFSProviderDiscover:
    @patch("flow_sdk.fs_store.factory.type_registry.type_registry")
    def test_discover_delegates_to_record_class(self, mock_registry):
        mock_cls = MagicMock()
        mock_cls.discover.return_value = [MagicMock(), MagicMock()]
        mock_registry.get.return_value = mock_cls

        provider = FSProvider()
        result = provider.discover("note")

        mock_registry.get.assert_called_once_with("note")
        mock_cls.discover.assert_called_once_with(scope=None)
        assert len(result) == 2

    @patch("flow_sdk.fs_store.factory.type_registry.type_registry")
    def test_discover_one_delegates(self, mock_registry):
        mock_cls = MagicMock()
        expected = MagicMock()
        mock_cls.discover_one.return_value = expected
        mock_registry.get.return_value = mock_cls

        provider = FSProvider()
        result = provider.discover_one("note", "abc-123")

        mock_registry.get.assert_called_once_with("note")
        mock_cls.discover_one.assert_called_once_with("abc-123")
        assert result is expected

    @patch("flow_sdk.fs_store.factory.type_registry.type_registry")
    def test_query_applies_in_memory(self, mock_registry):
        r1 = MagicMock()
        r1.id = "1"
        r1.type = "note"
        r1.status = "active"
        r1.created_at = None
        r1.modified_at = None
        r1.parent_ref = None

        r2 = MagicMock()
        r2.id = "2"
        r2.type = "note"
        r2.status = "archived"
        r2.created_at = None
        r2.modified_at = None
        r2.parent_ref = None

        mock_cls = MagicMock()
        mock_cls.discover.return_value = [r1, r2]
        mock_registry.get.return_value = mock_cls

        provider = FSProvider()
        q = RecordQuery(types=["note"], status="active")
        result = provider.query(q)

        assert len(result) == 1
        assert result[0].id == "1"

    def test_supports_pushdown_false(self):
        provider = FSProvider()
        q = RecordQuery(types=["note"])
        assert provider.supports_pushdown(q) is False

    def test_is_mutable_true(self):
        provider = FSProvider()
        assert provider.is_mutable is True

    def test_write_back_calls_persist(self):
        provider = FSProvider()
        record = MagicMock()
        provider.write_back(record)
        record.persist.assert_called_once()
