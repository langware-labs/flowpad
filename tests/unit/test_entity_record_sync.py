"""Unit tests for Entity–Record sync (post project-consolidation 2026-05-09).

Project identity is now an opaque ``uuid4``. The natural key for project dedup
is the canonical ``fs_storage_mount_path`` (i.e. ``cwd``). Lookup is via
``Project.find_by_cwd`` / ``Project.from_record``; both go through DB queries,
not through deterministic id derivation.
"""

import uuid
from typing import ClassVar
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


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
    """Project.allocate_id always returns a fresh uuid4. Identity is opaque;
    project dedup goes through ``find_by_cwd``, not via id derivation.
    """

    def test_project_allocate_id_returns_uuid(self):
        from flow_sdk.builtin.project import Project
        result = Project.allocate_id({"fs_storage_mount_path": "/tmp/anything"})
        # Must be a valid UUID string
        parsed = uuid.UUID(result)
        assert str(parsed) == result

    def test_project_allocate_id_random_per_call(self):
        from flow_sdk.builtin.project import Project
        data = {"fs_storage_mount_path": "/tmp/myproject"}
        id1 = Project.allocate_id(data)
        id2 = Project.allocate_id(data)
        # Same input → DIFFERENT ids (uuid4 is random; not derived from path).
        assert id1 != id2

    def test_project_allocate_id_returns_uuid_for_real_path(self):
        from flow_sdk.builtin.project import Project
        result = Project.allocate_id({"real_path": "/home/user/code"})
        # Just a valid UUID — not derived from the path.
        parsed = uuid.UUID(result)
        assert str(parsed) == result

    def test_project_allocate_id_no_path_returns_uuid4(self):
        from flow_sdk.builtin.project import Project
        id1 = Project.allocate_id({})
        id2 = Project.allocate_id({})
        uuid.UUID(id1)
        uuid.UUID(id2)
        assert id1 != id2

    def test_project_allocate_id_preserves_valid_provided_id(self):
        """If the caller passes in a valid uuid, we keep it (e.g. round-trips
        from the wire where the client minted a uuid4)."""
        from flow_sdk.builtin.project import Project
        provided = str(uuid.uuid4())
        result = Project.allocate_id({"fs_storage_mount_path": "/tmp/x", "id": provided})
        assert result == provided


class TestEntityRecordCwdSync:
    """Project ↔ Record dedup happens via canonical mount_path
    (``Project.find_by_cwd``), NOT via deterministic id derivation. These
    tests verify the dedup property holds across the entity-first / record-first
    / repeated-scan flows.
    """

    @pytest.mark.asyncio
    async def test_entity_first_record_scan_later(self, sync_db):
        """Entity created via API then record scanned → same DB row."""
        from flow_sdk.builtin.project import Project
        from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
        from flow_sdk.fs_store.path_utils import canonical_posix_path

        mount_path = "/tmp/testproject_entity_first"
        canonical = canonical_posix_path(mount_path)
        entity = Project(fs_storage_mount_path=canonical)
        entity.id = Project.allocate_id({"fs_storage_mount_path": canonical})
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

        result = await Project.from_record(mock_record)

        # Same DB row — id preserved across scan despite uuid4-not-derived ids,
        # because find_by_cwd returns the existing entity.
        assert result.id == entity.id, f"Expected {entity.id}, got {result.id}"

    @pytest.mark.asyncio
    async def test_record_scan_first_entity_created_later(self, sync_db):
        """Record scanned first → Project entity exists at the canonical cwd."""
        from flow_sdk.builtin.project import Project
        from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
        from flow_sdk.fs_store.path_utils import canonical_posix_path

        mount_path = "/tmp/testproject2_record_first"
        canonical = canonical_posix_path(mount_path)

        mock_record = MagicMock(spec=ClaudeProjectFsRecord)
        mock_record.type = "project"
        mock_record._record_type = "project"
        mock_record.data = {"real_path": mount_path, "encoded_path": "encoded2"}
        mock_record.meta_dict.return_value = {
            "name": "testproject2_record_first",
            "fs_storage_mount_path": mount_path,
        }
        mock_record._property_types = {}

        scanned = await Project.from_record(mock_record)

        # The scanned entity exists and is findable by canonical cwd.
        existing = await Project.find_by_cwd(canonical)
        assert existing is not None
        assert existing.id == scanned.id

    @pytest.mark.asyncio
    async def test_from_record_no_duplicate_on_rescan(self, sync_db):
        """Calling from_record twice for the same canonical cwd yields one entity."""
        from flow_sdk.builtin.project import Project
        from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
        from flow_sdk.fs_store.path_utils import canonical_posix_path
        from flow_sdk.db.drivers.query import QueryFilter

        mount_path = "/tmp/testproject3_no_dup"
        canonical = canonical_posix_path(mount_path)

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

        first = await Project.from_record(make_mock())
        second = await Project.from_record(make_mock())

        # Same entity (dedup by canonical cwd, regardless of id-derivation).
        assert first.id == second.id

        # And the canonical mount path appears exactly once in the DB.
        all_projects = await Project.get_all(QueryFilter.parse({"type": "project"}))
        matching = [
            p for p in all_projects
            if p.fs_storage_mount_path
            and canonical_posix_path(p.fs_storage_mount_path) == canonical
        ]
        assert len(matching) == 1, f"Expected 1 entity, got {len(matching)}"
