"""Tests for Record interface methods: meta_dict, index_content, record_type, unindex."""
from __future__ import annotations

from typing import Any, ClassVar
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.fs_store.record import Record, RecordStatus


class FakeRecord(Record):
    """Test record subclass with a known type."""
    _record_type: ClassVar[str] = "fake_record"


class FakeRecordWithContent(Record):
    """Test record subclass that overrides search_content."""
    _record_type: ClassVar[str] = "fake_with_content"

    @property
    def search_content(self) -> str | None:
        return "Hello, world!"


class TestMetaDict:
    def test_meta_dict_returns_identity_fields(self):
        rec = FakeRecord(
            id="abc-123",
            type="fake_record",
            name="Test Record",
            status="active",
            created_date="2026-01-01T00:00:00Z",
            updated_date="2026-01-02T00:00:00Z",
            scope="local",
        )
        meta = rec.meta_dict()
        assert meta["id"] == "abc-123"
        assert meta["type"] == "fake_record"
        assert meta["name"] == "Test Record"
        assert meta["status"] == "active"
        assert meta["created_date"] == "2026-01-01T00:00:00Z"
        assert meta["updated_date"] == "2026-01-02T00:00:00Z"
        assert meta["scope"] == "local"

    def test_meta_dict_omits_none_fields(self):
        rec = FakeRecord(id="abc-123", type="fake_record", name="Test")
        meta = rec.meta_dict()
        assert "id" in meta
        assert "type" in meta
        assert "name" in meta
        # These were not set, so should not appear
        assert "status" not in meta
        assert "created_date" not in meta
        assert "updated_date" not in meta
        assert "scope" not in meta

    def test_meta_dict_converts_enum_status(self):
        rec = FakeRecord(id="abc-123", type="fake_record", status=RecordStatus.ACTIVE)
        meta = rec.meta_dict()
        assert meta["status"] == "active"
        assert isinstance(meta["status"], str)

    def test_meta_dict_includes_all_public_fields(self):
        rec = FakeRecord(
            id="abc-123",
            type="fake_record",
            description="some description",
            custom_field="custom_value",
        )
        meta = rec.meta_dict()
        assert meta["description"] == "some description"
        assert meta["custom_field"] == "custom_value"


class TestIndexContent:
    def test_base_record_returns_none(self):
        rec = FakeRecord(id="abc-123")
        assert rec.index_content() is None

    def test_subclass_override_returns_text(self):
        rec = FakeRecordWithContent(id="abc-123")
        assert rec.index_content() == "Hello, world!"


class TestRecordType:
    def test_record_type_returns_classvar(self):
        assert FakeRecord.record_type() == "fake_record"

    def test_base_record_returns_empty(self):
        assert Record.record_type() == ""
