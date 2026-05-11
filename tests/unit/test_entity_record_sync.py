"""Unit tests for Entity–Record ID sync.

Tests that Entity.allocate_id and Project.allocate_id produce deterministic
UUIDs from a natural key (the project work directory), so that a Project entity
created via API and a Project entity created by scanning a ClaudeProjectFsRecord
both get the same DB row.
"""

import uuid
from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.fs_store.path_utils import canonical_posix_path


@pytest_asyncio.fixture
async def sync_db(tmp_path):
    """Isolated SQLite driver for ID-sync integration tests."""
    db_path = str(tmp_path / "id_sync.db")
    cfg = DBConfig()
    cfg.database = db_path
    driver = SQLiteDBDriver(cfg)
    await driver.open()

    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.schema.entity_factory import type_registry

    if type_registry.get("project") is None:
        from flow_sdk.builtin.project import Project
        type_registry.register("project", Project)

    old_instances = db_driver_mod._driver_instances.copy()
    db_driver_mod._driver_instances["sqlite"] = driver
    old_db = Entity.__dict__.get("_db")
    Entity._db = driver

    yield driver

    db_driver_mod._driver_instances.clear()
    db_driver_mod._driver_instances.update(old_instances)
    if old_db is None:
        if "_db" in Entity.__dict__:
            delattr(Entity, "_db")
    else:
        Entity._db = old_db
    await driver.close()


class TestEntityAllocateId:
    def test_allocate_id_base_returns_uuid4(self):
        from flow_sdk.core.entity.entity_model import Entity
        result = Entity.allocate_id({})
        # Must be a valid UUID string
        parsed = uuid.UUID(result)
        assert str(parsed) == result

    def test_allocate_id_base_is_random(self):
        from flow_sdk.core.entity.entity_model import Entity
        id1 = Entity.allocate_id({})
        id2 = Entity.allocate_id({})
        assert id1 != id2


class TestProjectAllocateId:
    def test_project_allocate_id_deterministic(self):
        from flow_sdk.builtin.project import Project
        data = {"fs_storage_mount_path": "/tmp/myproject"}
        id1 = Project.allocate_id(data)
        id2 = Project.allocate_id(data)
        assert id1 == id2

    def test_project_allocate_id_from_fs_storage_mount_path(self):
        from flow_sdk.builtin.project import Project
        expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "project:/foo/bar"))
        result = Project.allocate_id({"fs_storage_mount_path": "/foo/bar"})
        assert result == expected

    def test_project_allocate_id_from_name_absolute(self):
        from flow_sdk.builtin.project import Project
        expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "project:/foo/bar"))
        result = Project.allocate_id({"name": "/foo/bar"})
        assert result == expected

    def test_project_allocate_id_fs_storage_mount_path_wins_over_name(self):
        from flow_sdk.builtin.project import Project
        expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, "project:/actual/path"))
        result = Project.allocate_id({"fs_storage_mount_path": "/actual/path", "name": "/foo/bar"})
        assert result == expected

    def test_project_allocate_id_no_path_returns_uuid4(self):
        from flow_sdk.builtin.project import Project
        id1 = Project.allocate_id({})
        id2 = Project.allocate_id({})
        # Both valid UUIDs but not equal (random)
        uuid.UUID(id1)
        uuid.UUID(id2)
        assert id1 != id2

    def test_project_allocate_id_real_path(self):
        from flow_sdk.builtin.project import Project
        expected = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{canonical_posix_path('/home/user/code')}"))
        result = Project.allocate_id({"real_path": "/home/user/code"})
        assert result == expected


class TestEntityRecordIdSync:
    @pytest.mark.asyncio
    async def test_entity_first_record_scan_later(self, sync_db):
        """Entity created via API then record scanned → same DB row."""
        from flow_sdk.builtin.project import Project
        from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        mount_path = "/tmp/testproject_entity_first"
        entity = Project(fs_storage_mount_path=mount_path)
        entity.id = Project.allocate_id({"fs_storage_mount_path": mount_path})
        await entity.save()

        # Simulate scanning a record with the same path
        mock_record = MagicMock(spec=ClaudeProjectFsRecord)
        mock_record.type = "project"
        mock_record._record_type = "project"
        mock_record.data = {"real_path": mount_path, "encoded_path": "encoded"}
        mock_record.meta_dict.return_value = {
            "name": "testproject_entity_first",
            "fs_storage_mount_path": mount_path,
        }
        mock_record._property_types = {}

        with patch.object(SchemaRegistry, "get_entity_cls", return_value=Project):
            result = await Project.from_record(mock_record)

        assert result.id == entity.id, f"Expected {entity.id}, got {result.id}"

    @pytest.mark.asyncio
    async def test_record_scan_first_entity_created_later(self, sync_db):
        """Record scanned first, entity created later via API → same ID."""
        from flow_sdk.builtin.project import Project
        from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
        from flow_sdk.fs_store.schema_registry import SchemaRegistry

        mount_path = "/tmp/testproject2_record_first"

        mock_record = MagicMock(spec=ClaudeProjectFsRecord)
        mock_record.type = "project"
        mock_record._record_type = "project"
        mock_record.data = {"real_path": mount_path, "encoded_path": "encoded2"}
        mock_record.meta_dict.return_value = {
            "name": "testproject2_record_first",
            "fs_storage_mount_path": mount_path,
        }
        mock_record._property_types = {}

        with patch.object(SchemaRegistry, "get_entity_cls", return_value=Project):
            scanned = await Project.from_record(mock_record)

        expected_id = Project.allocate_id({"fs_storage_mount_path": mount_path})
        assert scanned.id == expected_id

    @pytest.mark.asyncio
    async def test_from_record_no_duplicate_on_rescan(self, sync_db):
        """Calling from_record twice for the same record yields one entity."""
        from flow_sdk.builtin.project import Project
        from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
        from flow_sdk.fs_store.schema_registry import SchemaRegistry
        from flow_sdk.db.drivers.query import QueryFilter

        mount_path = "/tmp/testproject3_no_dup"

        def make_mock():
            m = MagicMock(spec=ClaudeProjectFsRecord)
            m.type = "project"
            m._record_type = "project"
            m.data = {"real_path": mount_path, "encoded_path": "encoded3"}
            m.meta_dict.return_value = {
                "name": "testproject3_no_dup",
                "fs_storage_mount_path": mount_path,
            }
            m._property_types = {}
            return m

        with patch.object(SchemaRegistry, "get_entity_cls", return_value=Project):
            await Project.from_record(make_mock())
            await Project.from_record(make_mock())

        # Query DB directly for project entities with this mount path
        all_projects = await Project.get_all(QueryFilter.parse({"type": "project"}))
        canonical_mount_path = canonical_posix_path(mount_path)
        matching = [p for p in all_projects if getattr(p, "fs_storage_mount_path", None) == canonical_mount_path]
        assert len(matching) == 1, f"Expected 1 entity, got {len(matching)}"
