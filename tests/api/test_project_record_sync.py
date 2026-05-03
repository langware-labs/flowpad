"""Tests for ClaudeProjectFsRecord multi-source discovery and hash-based re-index.

Test 1: Create a Project record in records_root for a temp folder (no ~/.claude/projects/
        entry). Index it → entity in DB. Mutate the record name on disk. Run discover()
        + sync_to_db(). Assert the updated name is reflected in the DB entity.

Test 2: Same setup. Mutate the record name on disk and bump the asset's mtime
        past the DB row's updated_date so is_valid() returns False. Without running
        discover(), call entity.check_and_refresh_record(). Assert the updated name
        is in the DB.
"""

import uuid
import tempfile
from pathlib import Path

import pytest
import pytest_asyncio

from flow_sdk.builtin.project import Project
from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
from flow_sdk.fs_store.record import set_default_records_root


@pytest_asyncio.fixture(autouse=True)
async def _isolate_record_state():
    """Clear DB rows for record types these tests seed (project, claude_project),
    before AND after each test. Sibling tests in the api suite leak rows that
    pollute discover()/check_and_refresh_record() behavior."""
    from flow_sdk.db import get_db_driver
    driver = get_db_driver()
    for t in ("markdown", "asset", "claude_project", "project"):
        try:
            await driver.delete_entities_by_type(t)
        except Exception:
            pass
    yield
    for t in ("markdown", "asset", "claude_project", "project"):
        try:
            await driver.delete_entities_by_type(t)
        except Exception:
            pass


def _project_entity_id(workdir: str) -> str:
    """Mirror Project.allocate_id() for a given mount path."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{workdir}"))


@pytest.mark.asyncio
async def test_discover_picks_up_updated_project_name(bootstrapped_client):
    """Project record name updated on disk is reflected after discover + sync_to_db."""
    from flow_sdk.fs_store.record import get_default_records_root
    original_root = get_default_records_root()
    with tempfile.TemporaryDirectory() as records_tmp, \
         tempfile.TemporaryDirectory() as workdir:

        records_root = Path(records_tmp)
        set_default_records_root(records_root)

        try:
            entity_id = _project_entity_id(workdir)

            # 1. Create a ClaudeProjectFsRecord in records_root (no Claude project entry)
            rec = ClaudeProjectFsRecord(
                id=entity_id,
                name="Original Name",
                fs_storage_mount_path=workdir,
            )
            rec.save()
            assert ClaudeProjectFsRecord.get(entity_id) is not None, \
                "Record should be discoverable after save()"

            # 2. Index it → creates Project entity in DB
            await rec.sync_to_db()
            project = await Project.get_one({"id": entity_id})
            assert project is not None
            assert project.name == "Original Name"

            # 3. Mutate name on disk; subsequent sync_to_db picks up the new value.
            rec.name = "Updated Project Name"
            rec.save()

            # 4. Discover by id — must find the mutated record in records_root.
            # discover() filters out temp-path mount paths on purpose, so
            # iterate via get() which is an O(1) direct lookup.
            found = ClaudeProjectFsRecord.get(entity_id)
            assert found is not None, "get() must find the record in records_root"
            assert found.name == "Updated Project Name"

            # 5. Index the found record — pushes updated name into DB
            await found.sync_to_db()

            # 6. Fetch fresh entity — name must reflect the disk update
            refreshed = await Project.get_one({"id": entity_id})
            assert refreshed is not None
            assert refreshed.name == "Updated Project Name", (
                f"Expected 'Updated Project Name', got {refreshed.name!r}"
            )

        finally:
            set_default_records_root(original_root)


@pytest.mark.asyncio
async def test_asset_newer_than_db_triggers_reindex_via_check_and_refresh(bootstrapped_client):
    """Bumping asset mtime past DB updated_date → check_and_refresh_record() re-syncs."""
    import os, time as _time
    from flow_sdk.fs_store.record import get_default_records_root
    original_root = get_default_records_root()

    with tempfile.TemporaryDirectory() as records_tmp, \
         tempfile.TemporaryDirectory() as workdir:

        records_root = Path(records_tmp)
        set_default_records_root(records_root)

        try:
            entity_id = _project_entity_id(workdir)

            # 1. Create record + index → entity in DB
            rec = ClaudeProjectFsRecord(
                id=entity_id,
                name="Original Name",
                fs_storage_mount_path=workdir,
            )
            rec.save()
            await rec.sync_to_db()

            project = await Project.get_one({"id": entity_id})
            assert project is not None
            assert project.name == "Original Name"

            # 2. Silently mutate name on disk
            rec = ClaudeProjectFsRecord.get(entity_id)
            assert rec is not None
            rec.name = "Silently Changed Name"
            rec.save()

            # 3. Push asset paths' mtime past the DB row's updated_date so
            #    is_valid() returns False on the next check.
            future_ts = _time.time() + 10
            for p in rec._asset_paths():
                os.utime(p, (future_ts, future_ts))

            # 4. Do NOT call discover(). Trigger re-index via check_and_refresh_record().
            refreshed_flag = await project.check_and_refresh_record()
            assert refreshed_flag, "check_and_refresh_record() should have re-indexed"

            # 5. Fetch fresh entity — name must reflect the silently changed disk value
            fresh = await Project.get_one({"id": entity_id})
            assert fresh is not None
            assert fresh.name == "Silently Changed Name", (
                f"Expected 'Silently Changed Name', got {fresh.name!r}"
            )

        finally:
            set_default_records_root(original_root)
