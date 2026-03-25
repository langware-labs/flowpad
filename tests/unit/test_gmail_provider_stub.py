"""Tests for GmailProvider stub (submodule 8)."""

from __future__ import annotations

import pytest

from flow_sdk.fs_store.exceptions import ReadOnlyProviderError
from flow_sdk.fs_store.provider import GmailProvider
from flow_sdk.fs_store.record_query import RecordQuery


class TestGmailProviderStub:
    def test_discover_not_implemented(self):
        provider = GmailProvider()
        with pytest.raises(NotImplementedError):
            provider.discover("email")

    def test_discover_one_not_implemented(self):
        provider = GmailProvider()
        with pytest.raises(NotImplementedError):
            provider.discover_one("email", "abc")

    def test_query_not_implemented(self):
        provider = GmailProvider()
        with pytest.raises(NotImplementedError):
            provider.query(RecordQuery())

    def test_supports_pushdown_true(self):
        provider = GmailProvider()
        assert provider.supports_pushdown(RecordQuery()) is True

    def test_is_mutable_false(self):
        provider = GmailProvider()
        assert provider.is_mutable is False

    def test_write_back_raises_readonly(self):
        from unittest.mock import MagicMock
        provider = GmailProvider()
        with pytest.raises(ReadOnlyProviderError):
            provider.write_back(MagicMock())
