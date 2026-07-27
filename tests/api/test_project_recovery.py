"""Tests for Project.recover_by_path and AgenticProcess.recover_project_action.

Recovery walks 2 phases for a given workdir:
  1. Exact-match an existing Project by fs_storage_mount_path.
  2. Construct a fresh Project from the path (opaque uuid4 entity id).

These tests exercise the real DB + record bridge and prove path-based lookup
remains idempotent without making the path-derived record alias the entity id.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

# ---------------------------------------------------------------------------
# Project.recover_by_path
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recover_by_path_returns_none_for_empty(bootstrapped_client):
    """Empty path → None (nothing to recover)."""
    assert await Project.recover_by_path("") is None


@pytest.mark.asyncio
async def test_project_model_and_recovery_refuse_exact_user_home(
    bootstrapped_client,
):
    from flow_sdk.fs_store.indexer.roots import resolve_project_id_for_cwd
    from flow_sdk.instance_settings import get_instance_settings

    home = get_instance_settings().user_home
    project = Project(name=str(home), fs_storage_mount_path=str(home))

    assert project.fs_storage_mount_path == str(home)
    assert project.protected_path
    assert Project.derive_id_for_path(str(home)) is None
    assert resolve_project_id_for_cwd(str(home)) is None
    assert await Project.recover_by_path(str(home)) is None

    class LegacyHomeRecord:
        @staticmethod
        def meta_dict():
            return {"type": "project", "cwd": str(home), "name": str(home)}

    assert await Project.from_record(LegacyHomeRecord(), notify=False) is None


@pytest.mark.asyncio
async def test_recover_by_path_phase1_exact_existing_match(bootstrapped_client, tmp_path):
    """Phase 1: an existing Project at the exact path is returned as-is."""
    target = tmp_path / "phase1-project"
    target.mkdir()
    proj = Project(name=str(target), fs_storage_mount_path=str(target))
    proj.id = Project.allocate_id(proj.model_dump())
    await proj.save()

    recovered = await Project.recover_by_path(str(target))
    assert recovered is not None
    assert recovered.id == proj.id
    assert recovered.fs_storage_mount_path == str(target)


@pytest.mark.asyncio
async def test_recover_by_path_phase2_constructs_fresh_project(bootstrapped_client, tmp_path):
    """Phase 2: no existing Project → fresh opaque-id Project entity created."""
    # Use an absolute path that no project owns; isolate from any pre-seeded data.
    from flow_sdk.fs_store.path_utils import canonical_posix_path
    fresh = str(tmp_path / "phase2-fresh-only")
    canonical = canonical_posix_path(fresh)
    recovered = await Project.recover_by_path(fresh)
    assert recovered is not None
    assert recovered.fs_storage_mount_path == canonical
    assert uuid.UUID(recovered.id).version == 4
    assert recovered.id != Project.derive_id_for_path(canonical)

    # A follow-up lookup hits phase 1 by canonical path and returns the same row.
    again = await Project.recover_by_path(fresh)
    assert again is not None
    assert again.id == recovered.id
    assert again.fs_storage_mount_path == canonical


@pytest.mark.asyncio
async def test_recover_by_path_refuses_agent_mount_root(bootstrapped_client, tmp_path, monkeypatch):
    """The agent mount ROOT (~/Flowpad workspace) is infrastructure, not a
    project: recover_by_path returns None (→ @local fallback) and mints nothing,
    so agentic-process init never creates a stray "Flowpad workspace" project."""
    import flow_sdk.config as cfg
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    mount_root = tmp_path / "Flowpad workspace"
    mount_root.mkdir()
    canonical = canonical_posix_path(mount_root)

    # Point the mount-root predicate at our tmp workspace.
    monkeypatch.setattr(cfg, "AGENT_MOUNT_FOLDER", canonical)
    monkeypatch.setattr(cfg, "agent_workspace_root", lambda: mount_root)

    assert await Project.recover_by_path(str(mount_root)) is None
    # Nothing was persisted for the root.
    assert await Project.find_by_cwd(canonical) is None

    # A real work subfolder under the root is still a valid project.
    sub = mount_root / "real-project"
    sub.mkdir()
    recovered = await Project.recover_by_path(str(sub))
    assert recovered is not None
    assert recovered.fs_storage_mount_path == canonical_posix_path(sub)


@pytest.mark.asyncio
async def test_reap_protected_path_projects(bootstrapped_client, tmp_path, monkeypatch):
    """Startup cleanup removes only unsafe rows/shadows, never source content
    or normal relationship targets."""
    import flow_sdk.config as cfg
    import flow_sdk.fs_store.indexer.roots as roots
    import flow_sdk.fs_store.operations.all_projects as all_projects
    from flow_sdk.core.cache.entity_cache import entity_cache, uname_cache
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.fs_store.path_utils import canonical_posix_path
    from flow_sdk.instance_settings import get_instance_settings
    from flow_sdk.server.routes.bootstrap import _reap_protected_path_projects

    mount_root = tmp_path / "Flowpad workspace"
    mount_root.mkdir()
    (mount_root / "source.txt").write_text("keep")
    canonical = canonical_posix_path(mount_root)
    monkeypatch.setattr(cfg, "AGENT_MOUNT_FOLDER", canonical)
    monkeypatch.setattr(cfg, "agent_workspace_root", lambda: mount_root)

    # Stale mount-root project: construct safely, then bypass the new validator
    # to reproduce raw legacy DB + shadow metadata.
    stale = Project(
        name="Flowpad workspace",
        uname="legacy-protected-root",
        fs_storage_mount_path=str(tmp_path / "safe-seed"),
    )
    object.__setattr__(stale, "fs_storage_mount_path", canonical)
    stale.id = Project.allocate_id(stale.model_dump())
    await stale.save()
    stale_shadow = FSRecord(
        type="project",
        id=stale.id,
        fs_storage_mount_path=canonical,
        name=stale.name,
    )
    stale_shadow.save()

    # A real subfolder project that must survive the reap.
    sub = mount_root / "real-project"
    sub.mkdir()
    sub_path = canonical_posix_path(sub)
    keep = Project(name="real-project", fs_storage_mount_path=sub_path)
    keep.id = Project.allocate_id(keep.model_dump())
    await keep.save()
    await stale.add_child(keep)
    # A stale unsafe shadow must not condemn an independently safe DB row.
    keep_shadow = FSRecord(
        type="project",
        id=keep.id,
        fs_storage_mount_path=str(get_instance_settings().user_home),
        name=keep.name,
    )
    keep_shadow.save()

    # Exact HOME is independently unsafe; cleanup must preserve the directory
    # and its contents just like the agent workspace source.
    home = get_instance_settings().user_home
    home_sentinel = home / "reaper-preserves-home.txt"
    home_sentinel.write_text("keep home")
    stale_home = Project(
        name="legacy-home",
        fs_storage_mount_path=str(tmp_path / "safe-home-seed"),
    )
    object.__setattr__(stale_home, "fs_storage_mount_path", str(home))
    stale_home.id = Project.allocate_id(stale_home.model_dump())
    await stale_home.save()
    home_shadow = FSRecord(
        type="project",
        id=stale_home.id,
        fs_storage_mount_path=str(home),
        name=stale_home.name,
    )
    home_shadow.save()

    await all_projects.get_cached_projects(force=True)
    roots._CWD_PID_CACHE["unsafe"] = stale.id
    entity_cache.set(str(stale.typeid), stale)
    uname_cache.set_id("project", stale.uname, stale.id)

    await _reap_protected_path_projects()

    assert await Project.find_by_cwd(canonical) is None, "stale mount-root project not reaped"
    assert await Project.get_by_id(stale.id) is None
    assert await Project.get_by_id(stale_home.id) is None
    assert not stale_shadow.shadow_dir.exists()
    assert not home_shadow.shadow_dir.exists()
    assert not keep_shadow.shadow_dir.exists()
    assert (mount_root / "source.txt").read_text() == "keep"
    assert home_sentinel.read_text() == "keep home"
    assert await Project.get_by_id(keep.id) is not None, "relationship target must survive"
    assert await Project.find_by_cwd(sub_path) is not None, "subproject must survive"
    assert all_projects._PROJECTS_CACHE is None
    assert roots._CWD_PID_CACHE == {}
    assert entity_cache.get(str(stale.typeid)) is None
    assert uname_cache.get_id("project", stale.uname) is None

    # Idempotent: a second run is a clean no-op.
    await _reap_protected_path_projects()
    assert await Project.find_by_cwd(sub_path) is not None
    home_sentinel.unlink()


# ---------------------------------------------------------------------------
# AgenticProcess.recover_project_action
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recover_project_action_repoints_and_returns_entity():
    """Happy path: action calls recover_by_path, repoints project_id, saves, returns entity."""
    proc = AgenticProcess(id=str(uuid.uuid4()), workdir="/Users/x/foo")

    # ``_bind_project_id`` constructs a TypeId from this value; needs to be uuid-shaped.
    recovered_pid = str(uuid.uuid4())

    fake_project = MagicMock()
    fake_project.id = recovered_pid
    fake_project.model_dump = MagicMock(return_value={"id": recovered_pid, "type": "project"})

    with patch.object(Project, "recover_by_path", new=AsyncMock(return_value=fake_project)) as mock_recover, \
         patch.object(AgenticProcess, "save", new=AsyncMock()) as mock_save:
        result = await proc.recover_project_action()

    mock_recover.assert_awaited_once_with("/Users/x/foo")
    mock_save.assert_awaited_once()
    assert proc.project_id == recovered_pid
    assert isinstance(result, ApiSuccessResponse)
    assert result.data == {"project": {"id": recovered_pid, "type": "project"}}


@pytest.mark.asyncio
async def test_recover_project_action_fails_when_no_workdir():
    """Without workdir, recovery cannot proceed → ApiFailResponse."""
    proc = AgenticProcess(id=str(uuid.uuid4()), workdir=None)
    result = await proc.recover_project_action()
    assert isinstance(result, ApiFailResponse)
    assert "no workdir" in result.message.lower()


@pytest.mark.asyncio
async def test_recover_project_action_fails_when_recovery_returns_none():
    """If recover_by_path returns None, action fails (not a 200)."""
    proc = AgenticProcess(id=str(uuid.uuid4()), workdir="/any/path")

    with patch.object(Project, "recover_by_path", new=AsyncMock(return_value=None)):
        result = await proc.recover_project_action()

    assert isinstance(result, ApiFailResponse)
    assert "/any/path" in result.message
