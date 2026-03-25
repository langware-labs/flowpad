"""Tests for the Record ID system.

All record IDs must be valid UUIDs (v4 random, or v5 derived via identity_key/fingerprint).
The uid property and uid_field_name ClassVar have been removed.
"""

from __future__ import annotations

import uuid as _uuid
from typing import ClassVar
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.fs_store.record import Record, set_default_records_root


class UuidRecord(Record):
    """Record subclass with default UUID id."""
    _record_type: ClassVar[str] = "uuid_test"


class DerivedRecord(Record):
    """Record subclass that derives its id from identity_key (uuid5)."""
    _record_type: ClassVar[str] = "derived_test"

    @property
    def identity_key(self):
        return self.name or None


@pytest.fixture
def tmp_records(tmp_path):
    from flow_sdk.fs_store.record import get_default_records_root
    original = get_default_records_root()
    set_default_records_root(tmp_path)
    yield tmp_path
    set_default_records_root(original)


class TestRecordId:
    """Tests for Record ID properties."""

    def test_uuid_record_id_is_returned(self, tmp_records):
        """Record with explicit UUID id keeps that id."""
        test_uuid = str(_uuid.uuid4())
        rec = UuidRecord(id=test_uuid, type="uuid_test", name="Test")
        assert rec.id == test_uuid

    def test_record_auto_generates_uuid4_when_no_id(self, tmp_records):
        """Record with no id gets a random UUID4."""
        rec = UuidRecord(type="uuid_test", name="Test")
        _uuid.UUID(rec.id, version=4)  # raises if not valid uuid4

    def test_identity_key_derives_uuid5(self, tmp_records):
        """Record with identity_key override derives uuid5 when no id given."""
        rec = DerivedRecord(name="my-rule")
        expected = str(_uuid.uuid5(_uuid.NAMESPACE_DNS, "derived_test:my-rule"))
        assert rec.id == expected

    def test_explicit_id_wins_over_identity_key(self, tmp_records):
        """Constructor-provided id always wins over identity_key."""
        explicit_id = str(_uuid.uuid4())
        rec = DerivedRecord(id=explicit_id, name="my-rule")
        assert rec.id == explicit_id

    def test_no_uid_property(self, tmp_records):
        """Record no longer has a uid property."""
        rec = UuidRecord(type="uuid_test", name="Test")
        assert not isinstance(getattr(type(rec), "uid", None), property)

    def test_no_uid_field_name_classvar(self, tmp_records):
        """Record base class no longer defines uid_field_name."""
        assert not hasattr(Record, "uid_field_name")

    @pytest.mark.asyncio
    async def test_entity_from_record_uses_record_id(self, tmp_records):
        """Entity.from_record() uses record.id as entity id."""
        test_uuid = str(_uuid.uuid4())
        rec = UuidRecord(id=test_uuid, type="uuid_test", name="Test")

        with patch("flow_sdk.core.entity.entity_model.Entity.get_one", return_value=None), \
             patch("flow_sdk.core.entity.entity_model.Entity.save", new_callable=AsyncMock), \
             patch("flow_sdk.core.entity.entity_model.SchemaRegistry.get_entity_cls", return_value=None):
            from flow_sdk.core.entity.entity_model import Entity
            entity = await Entity.from_record(rec)
            assert entity.id == test_uuid

    @pytest.mark.asyncio
    async def test_unindex_deletes_entity_by_id(self, tmp_records):
        """unindex() deletes entity by id via Entity.get_one + entity.delete()."""
        test_uuid = str(_uuid.uuid4())
        rec = UuidRecord(id=test_uuid, type="uuid_test", name="Test")

        from flow_sdk.core.entity.entity_model import Entity
        mock_entity = AsyncMock()
        mock_entity.id = test_uuid

        with patch.object(Entity, "get_one", AsyncMock(return_value=mock_entity)), \
             patch("flow_sdk.db.get_db_driver", return_value=object()):
            await rec.unindex()
            mock_entity.delete.assert_awaited_once()
