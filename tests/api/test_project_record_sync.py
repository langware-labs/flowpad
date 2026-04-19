"""Tests for ClaudeProjectFsRecord multi-source discovery and hash-based re-index.

Test 1: Create a Project record in records_root for a temp folder (no ~/.claude/projects/
        entry). Index it → entity in DB. Mutate the record name on disk. Run discover()
        + sync_to_db(). Assert the updated name is reflected in the DB entity.

Test 2: Same setup. Mutate the record name on disk and delete the hash sentinel so
        record_update_required() returns True. Without running discover(), call
        entity.check_and_refresh_record(). Assert the updated name is in the DB.
"""

import uuid
import tempfile
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.fs_records.claude.claude_project import ClaudeProjectFsRecord
from flow_sdk.fs_store.record import set_default_records_root


def _project_entity_id(workdir: str) -> str:
    """Mirror Project.allocate_id() for a given mount path."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"project:{workdir}"))


@pytest.mark.asyncio
async def test_discover_picks_up_updated_project_name(bootstrapped_client):
    """Project record name updated on disk is reflected after discover + sync_to_db."""
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
            assert ClaudeProjectFsRecord.discover_one(entity_id) is not None, \
                "Record should be discoverable after save()"

            # 2. Index it → creates Project entity in DB
            await rec.sync_to_db()
            project = await Project.get_one({"id": entity_id})
            assert project is not None
            assert project.name == "Original Name"

            # 3. Mutate name on disk — delete sentinel to force re-index on next sync
            rec.name = "Updated Project Name"
            rec.save()
            if rec.index_state_dir:
                for h in rec.index_state_dir.glob("*.hash"):
                    h.unlink()

            # 4. Discover by id — must find the mutated record in records_root.
            # discover_iter() filters out temp-path mount paths on purpose, so
            # iterate via discover_one() which is an O(1) direct lookup.
            found = ClaudeProjectFsRecord.discover_one(entity_id)
            assert found is not None, "discover_one() must find the record in records_root"
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
            set_default_records_root(Path.home() / ".flow" / "records")


@pytest.mark.asyncio
async def test_hash_change_triggers_reindex_via_check_and_refresh(bootstrapped_client):
    """Stale hash sentinel causes check_and_refresh_record() to re-index without discover()."""
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
            rec = ClaudeProjectFsRecord.discover_one(entity_id)
            assert rec is not None
            rec.name = "Silently Changed Name"
            rec.save()

            # 3. Delete the hash sentinel — record_update_required() returns True
            if rec.index_state_dir:
                for h in rec.index_state_dir.glob("*.hash"):
                    h.unlink()
            assert rec.index_required, "index_required must be True after sentinel deleted"

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
            set_default_records_root(Path.home() / ".flow" / "records")
