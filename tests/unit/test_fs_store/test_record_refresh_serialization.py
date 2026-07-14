"""Regression coverage for GET-time record freshness and opposite sync races."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

from flow_sdk.builtin.project import Project
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.fs_store.fs_record import FSRecord


def _advance_directory_mtime(path: Path) -> None:
    """Make a folder-backed record genuinely stale without a timing wait."""
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))


@pytest.mark.asyncio
async def test_fresh_project_record_check_is_read_only(
    sync_db, tmp_records_root, monkeypatch
) -> None:
    project_root = tmp_records_root / "fresh-project"
    project_root.mkdir()
    project = Project(
        id=str(uuid.uuid4()),
        name="fresh-project",
        fs_storage_mount_path=str(project_root),
        last_mode="dev",
    )
    await project.save()

    record = FSRecord.load("project", project.id)
    assert record.asset_ref is None, "Project stores its mount under its typed metadata key"
    assert record.ensure_asset_ref().index_required is False

    metadata_path = record.metadata_ref._path
    before_bytes = metadata_path.read_bytes()
    before_mtime = metadata_path.stat().st_mtime_ns
    before_db = await Project.get_one({"id": project.id})
    assert before_db is not None
    before_updated = before_db.updated_date
    effects: list[str] = []

    async def unexpected_sync(*_args, **_kwargs) -> None:
        effects.append("sync_to_db")

    def unexpected_hash(*_args, **_kwargs) -> None:
        effects.append("write_hash")

    async def unexpected_notification(*_args, **_kwargs) -> None:
        effects.append("notification")

    monkeypatch.setattr(FSRecord, "sync_to_db", unexpected_sync)
    monkeypatch.setattr(FSRecord, "write_hash", unexpected_hash)
    monkeypatch.setattr(
        Entity,
        "add_entity_op_notification",
        staticmethod(unexpected_notification),
    )

    assert await project.check_and_refresh_record() is False

    after_db = await Project.get_one({"id": project.id})
    assert after_db is not None
    assert after_db.last_mode == "dev"
    assert after_db.updated_date == before_updated
    assert effects == []
    assert metadata_path.read_bytes() == before_bytes
    assert metadata_path.stat().st_mtime_ns == before_mtime


@pytest.mark.asyncio
async def test_stale_refresh_cannot_interleave_normal_save(
    sync_db, tmp_records_root, monkeypatch
) -> None:
    """A stale disk->DB adoption and DB->disk save serialize by record id."""
    import flow_sdk.fs_store.fs_record as fs_record_mod

    project_root = tmp_records_root / "racing-project"
    project_root.mkdir()
    project = Project(
        id=str(uuid.uuid4()),
        name="racing-project",
        fs_storage_mount_path=str(project_root),
        last_mode="bogus-mode",
    )
    await project.save()
    writer = await Project.get_one({"id": project.id})
    assert writer is not None
    writer.last_mode = "dev"

    record = FSRecord.load("project", project.id).ensure_asset_ref()
    assert record.index_required is False
    _advance_directory_mtime(project_root)
    assert record.index_required is True, "precondition: refresh has real stale work"

    refresh_inside_sync = asyncio.Event()
    release_refresh = asyncio.Event()
    save_attempted_guard = asyncio.Event()
    original_unlocked = FSRecord._sync_to_db_unlocked
    original_guard = fs_record_mod.record_sync_guard
    save_task: asyncio.Task | None = None

    async def gated_sync(self, *args, **kwargs) -> None:
        if self.type == "project" and str(self.id) == project.id:
            refresh_inside_sync.set()
            await release_refresh.wait()
        await original_unlocked(self, *args, **kwargs)

    @asynccontextmanager
    async def observed_guard(record_type: str, record_id: str):
        if asyncio.current_task() is save_task:
            save_attempted_guard.set()
        async with original_guard(record_type, record_id):
            yield

    monkeypatch.setattr(FSRecord, "_sync_to_db_unlocked", gated_sync)
    monkeypatch.setattr(fs_record_mod, "record_sync_guard", observed_guard)

    refresh_task = asyncio.create_task(project.check_and_refresh_record())
    await refresh_inside_sync.wait()
    save_task = asyncio.create_task(writer.save())
    await save_attempted_guard.wait()
    assert not save_task.done(), "normal save must wait while stale adoption owns the guard"

    release_refresh.set()
    refreshed, _ = await asyncio.gather(refresh_task, save_task)
    assert refreshed is True

    persisted = await Project.get_one({"id": project.id})
    assert persisted is not None
    assert persisted.last_mode == "dev"
    disk = json.loads(FSRecord.load("project", project.id).metadata_ref._path.read_text())
    assert disk["last_mode"] == "dev"


@pytest.mark.asyncio
async def test_activate_partially_mirrors_shell_recency_without_stale_clobber(
    sync_db, tmp_records_root
) -> None:
    from flow_sdk.builtin.shell import Shell, ShellStatus
    from flow_sdk.core.entity.entity_model import _http_activate

    shell = Shell(
        id=str(uuid.uuid4()),
        name="activation-shell",
        status=ShellStatus.IDLE.value,
        workdir=str(tmp_records_root),
    )
    await shell.save()
    stale = await Shell.get_one({"id": shell.id})
    current = await Shell.get_one({"id": shell.id})
    assert stale is not None and current is not None

    current.status = ShellStatus.CLOSED.value
    await current.save()
    assert stale.status == ShellStatus.IDLE.value

    response = await _http_activate(stale)

    persisted = await Shell.get_one({"id": shell.id})
    assert persisted is not None
    assert persisted.status == ShellStatus.CLOSED.value
    assert persisted.last_active_at == response.data["last_active_at"]
    disk = json.loads(FSRecord.load("shell", shell.id).metadata_ref._path.read_text())
    assert disk["status"] == ShellStatus.CLOSED.value
    assert disk["last_active_at"] == response.data["last_active_at"]
