"""Driven test: workspace-folder discovery in ``get_all_projects``.

Every non-hidden top-level folder under ``<user_home>/Flowpad workspace`` must
be discovered, minted a stable v5 id, and materialized as a persisted Project
entity — the exact same reconcile → mint → materialize path Claude/Codex
cwds take. Drives the real SQLite persistence layer (no mocks of save/query).
"""

import asyncio
import uuid

import pytest
import pytest_asyncio

import flow_sdk.builtin.faas.project_list as project_list
import flow_sdk.db.drivers.db_driver as db_driver_mod
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


@pytest_asyncio.fixture
async def project_db(tmp_path):
    """Isolated SQLite driver with the ``project`` type registered."""
    cfg = DBConfig()
    cfg.database = str(tmp_path / "workspace_projects.db")
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


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_workspace_folders_materialize_as_projects(project_db, tmp_path, monkeypatch):
    home = tmp_path / "home"
    ws = home / "Flowpad workspace"
    ws.mkdir(parents=True)
    (ws / "proj_a").mkdir()
    (ws / "proj_b").mkdir()
    (ws / ".hidden").mkdir()            # dotfolder -> skipped
    (ws / "readme.md").write_text("x")  # file -> skipped

    # Settings is a frozen dataclass: build a modified copy that redirects the
    # three discovery paths + isolates the capsule root, while inheriting the
    # rest of the real test settings. Claude/Codex point at absent paths so
    # only the workspace scan contributes.
    import dataclasses

    import flow_sdk.instance_settings as isettings
    records_root = tmp_path / "records"
    # The autouse records-root fixture redirects live record writers here, so
    # a background task from the shared test app may create it first.
    records_root.mkdir(exist_ok=True)
    patched = dataclasses.replace(
        isettings.get_instance_settings(),
        user_home=home,
        claude_projects_dir=home / ".claude" / "projects",
        codex_config_path=home / ".codex" / "config.toml",
        records_root=records_root,
    )
    import flow_sdk.fs_store.operations.all_projects as ap
    monkeypatch.setattr(ap, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(isettings, "get_instance_settings", lambda: patched)

    from flow_sdk.builtin.project import Project
    from flow_sdk.api.api_types.identifier import is_valid_entity_id
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    # tmp_path is under the system temp dir, so include_temp=True is required
    # for the sandbox workspace folders to survive the temp filter.
    projects = await ap.get_all_projects(include_temp=True, create_missing=True)

    by_name = {p.name: p for p in projects}
    assert "proj_a" in by_name, by_name
    assert "proj_b" in by_name, by_name
    assert ".hidden" not in by_name
    assert "readme.md" not in by_name

    for name in ("proj_a", "proj_b"):
        info = by_name[name]
        cwd = canonical_posix_path(ws / name)

        # No worker tag — pure workspace folder.
        assert info.worker_types == [], info.worker_types
        # Minted this call.
        assert info.is_new is True

        # Id is a valid opaque entity id (v4 — Project ids are random like every
        # other entity; dedup is find_by_cwd's job, NOT a path-derived id).
        assert is_valid_entity_id(info.project_id), info.project_id
        assert uuid.UUID(info.project_id).version == 4
        # derive_id_for_path lives on only as a record-match ALIAS, never the id.
        assert info.project_id != Project.derive_id_for_path(cwd)

        # Persisted: queryable by its natural key, same id.
        persisted = await Project.find_by_cwd(cwd)
        assert persisted is not None, f"{name} not persisted"
        assert persisted.id == info.project_id

    # Idempotent: a second call reuses the rows, mints nothing new.
    again = await ap.get_all_projects(include_temp=True, create_missing=True)
    again_by_name = {p.name: p for p in again}
    for name in ("proj_a", "proj_b"):
        assert again_by_name[name].is_new is False
        assert again_by_name[name].project_id == by_name[name].project_id


@pytest.fixture(autouse=True)
def _fresh_project_list_cache():
    """The picker's disk snapshot is module state; no test may inherit one."""
    project_list.invalidate_project_list_cache()
    yield
    project_list.invalidate_project_list_cache()


class _PickerDisk:
    """Stub disk behind ``list_projects_from_indexer``: the workspace iterator
    yields the folders under ``root`` that still exist, and every call to it is
    one scan. ``now`` is the listing cache's monotonic clock."""

    def __init__(self, monkeypatch, root, *names):
        import flow_sdk.fs_store.operations.all_projects as ap

        self.root = root
        self.folders = []
        self.scans = 0
        self.now = 1000.0
        for name in names:
            self.add(name)
        monkeypatch.setattr(ap, "iter_claude_project_paths", lambda **kwargs: iter(()))
        monkeypatch.setattr(ap, "iter_codex_project_paths", lambda **kwargs: iter(()))
        monkeypatch.setattr(ap, "iter_copilot_project_paths", lambda **kwargs: iter(()))
        monkeypatch.setattr(ap, "iter_workspace_project_paths", self._workspace)

        # tmp_path is under the system temp dir: keep it past the temp filter.
        real_scan = ap.scan_project_cwds
        real_join = ap.join_projects

        async def read_only_join(scanned, *, create_missing):
            assert create_missing is False
            return await real_join(scanned, include_temp=True, create_missing=create_missing)

        monkeypatch.setattr(ap, "scan_project_cwds", lambda: real_scan(include_temp=True))
        monkeypatch.setattr(ap, "join_projects", read_only_join)
        monkeypatch.setattr(project_list, "is_valid_project_cwd", lambda _cwd: True)
        monkeypatch.setattr(project_list, "_codex_activity_by_cwd", lambda: {})
        monkeypatch.setattr(project_list, "_copilot_activity_by_cwd", lambda: {})
        monkeypatch.setattr(project_list, "_index_claude_dirs_by_cwd", lambda _root: {})
        monkeypatch.setattr(project_list, "_now", lambda: self.now)

    def add(self, name):
        """Create ``root/name`` on disk and list it; returns the folder."""
        folder = self.root / name
        folder.mkdir()
        self.folders.append(folder)
        return folder

    def cwd(self, name):
        return str((self.root / name).resolve())

    def _workspace(self, **kwargs):
        self.scans += 1
        return iter([folder for folder in self.folders if folder.is_dir()])


def _cwds(result):
    return [row["cwd"] for row in result["projects"]]


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_listing_discovers_paths_without_materializing_them(
    project_db,
    tmp_path,
    monkeypatch,
):
    """The picker returns discovered cwds but never bulk-creates Project rows."""
    from flow_sdk.builtin.project import Project

    disk = _PickerDisk(monkeypatch, tmp_path, "historical-worker-project")

    before = await Project.get_all()
    result = await project_list.list_projects_from_indexer()
    after = await Project.get_all()

    assert _cwds(result) == [disk.cwd("historical-worker-project")]
    assert after == before == []
    assert await Project.find_by_cwd(disk.cwd("historical-worker-project")) is None


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_listing_reuses_the_disk_scan(project_db, tmp_path, monkeypatch):
    """A second listing inside the TTL reads nothing off disk."""
    disk = _PickerDisk(monkeypatch, tmp_path, "first")

    await project_list.list_projects_from_indexer()
    disk.add("later")
    disk.now += 59
    again = await project_list.list_projects_from_indexer()

    assert disk.scans == 1
    assert _cwds(again) == [disk.cwd("first")]


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_concurrent_listings_share_one_scan(project_db, tmp_path, monkeypatch):
    disk = _PickerDisk(monkeypatch, tmp_path, "folder")

    results = await asyncio.gather(*(project_list.list_projects_from_indexer() for _ in range(4)))

    assert disk.scans == 1
    assert all(_cwds(result) == [disk.cwd("folder")] for result in results)


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_serves_stale_snapshot_while_it_refreshes(project_db, tmp_path, monkeypatch):
    """Past the TTL the old list answers at once; one background scan replaces it."""
    disk = _PickerDisk(monkeypatch, tmp_path, "first")
    await project_list.list_projects_from_indexer()

    disk.add("later")
    disk.now += 120
    stale = await project_list.list_projects_from_indexer()
    assert _cwds(stale) == [disk.cwd("first")]

    refresh = project_list._inflight
    if refresh is not None:  # else the refresh already landed during the join
        await refresh
    # A task that finished before the await returns at once, with its done-callback
    # (the one storing the snapshot) still queued for the loop's next turn.
    await asyncio.sleep(0)
    fresh = await project_list.list_projects_from_indexer()

    assert disk.scans == 2
    assert sorted(_cwds(fresh)) == sorted([disk.cwd("first"), disk.cwd("later")])


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_blocks_on_a_snapshot_older_than_ten_minutes(project_db, tmp_path, monkeypatch):
    disk = _PickerDisk(monkeypatch, tmp_path, "first")
    await project_list.list_projects_from_indexer()

    disk.add("later")
    disk.now += 601
    result = await project_list.list_projects_from_indexer()

    assert disk.scans == 2
    assert sorted(_cwds(result)) == sorted([disk.cwd("first"), disk.cwd("later")])


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_invalidate_forces_a_rescan(project_db, tmp_path, monkeypatch):
    disk = _PickerDisk(monkeypatch, tmp_path, "folder")
    await project_list.list_projects_from_indexer()

    disk.folders[0].rmdir()
    project_list.invalidate_project_list_cache()
    result = await project_list.list_projects_from_indexer()

    assert disk.scans == 2
    assert _cwds(result) == []


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_shows_a_rename_without_rescanning(project_db, tmp_path, monkeypatch):
    """Only the disk is cached: the Project table is joined fresh every listing."""
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    disk = _PickerDisk(monkeypatch, tmp_path, "folder")
    project = Project.model_validate({"fs_storage_mount_path": canonical_posix_path(disk.folders[0]), "name": "before"})
    project.id = Project.allocate_id(project.model_dump())
    await project.save()

    assert [row["name"] for row in (await project_list.list_projects_from_indexer())["projects"]] == ["before"]
    project.name = "after"
    await project.save()
    renamed = await project_list.list_projects_from_indexer()

    assert disk.scans == 1
    assert [(row["id"], row["name"]) for row in renamed["projects"]] == [(project.id, "after")]


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_rows_are_not_shared_between_listings(project_db, tmp_path, monkeypatch):
    disk = _PickerDisk(monkeypatch, tmp_path, "folder")

    first = await project_list.list_projects_from_indexer()
    row = first["projects"][0]
    row["name"] = "scribbled"
    row["worker_types"].append("scribbled")
    first["projects"].append({"cwd": "/scribbled"})
    second = await project_list.list_projects_from_indexer()

    assert disk.scans == 1
    assert [(r["name"], r["worker_types"]) for r in second["projects"]] == [("folder", [])]


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_delete_with_children_drops_the_picker_snapshot(tmp_path, monkeypatch):
    """Deleting a project removes its folder; the next listing must not serve
    the snapshot that still contains it."""
    from flow_sdk.builtin.project import Project

    disk = _PickerDisk(monkeypatch, tmp_path, "doomed")
    folder = disk.folders[0]
    project = await Project(name=str(folder)).save()
    assert disk.cwd("doomed") in _cwds(await project_list.list_projects_from_indexer())

    await project._delete_with_children(folder="rmtree", delete_chats=False)
    result = await project_list.list_projects_from_indexer()

    assert not folder.exists()
    assert disk.scans == 2
    assert disk.cwd("doomed") not in _cwds(result)


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_cleanup_apply_drops_the_picker_snapshot(project_db, tmp_path, monkeypatch):
    """Clearing a project's harness state changes what the scan finds; the next
    listing must rescan rather than serve the snapshot taken before it."""
    from types import SimpleNamespace

    from flow_sdk.builtin.faas import scan_actions
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.operations import project_cleanup
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    disk = _PickerDisk(monkeypatch, tmp_path, "folder")
    project = Project.model_validate({"fs_storage_mount_path": canonical_posix_path(disk.folders[0]), "name": "folder"})
    project.id = Project.allocate_id(project.model_dump())
    await project.save()
    await project_list.list_projects_from_indexer()

    async def body():
        return {"project_ids": [project.id]}

    request_info = SimpleNamespace(request=SimpleNamespace(json=body))
    monkeypatch.setattr(scan_actions, "get_current_request_info", lambda: request_info)
    monkeypatch.setattr(project_cleanup.HarnessIndex, "build", classmethod(lambda cls: None))
    monkeypatch.setattr(project_cleanup, "remove_from_harness", lambda row, index: {"cwd": row["cwd"]})

    response = await scan_actions.ScanActionsMixin._scan_project_cleanup_apply(None, permanent=False)
    assert response.data["succeeded"] == 1
    await project_list.list_projects_from_indexer()

    assert disk.scans == 2


def test_copilot_project_iterator_rejects_home_but_keeps_subdir(
    tmp_path,
    monkeypatch,
):
    import dataclasses

    import flow_sdk.fs_store.operations.all_projects as ap
    import flow_sdk.instance_settings as isettings

    home = tmp_path / "home"
    project = home / "dev" / "repo"
    project.mkdir(parents=True)
    sessions = home / ".copilot" / "session-state"
    for name, cwd in (("home", home), ("project", project)):
        workspace = sessions / name / "workspace.yaml"
        workspace.parent.mkdir(parents=True)
        workspace.write_text(f"cwd: {cwd}\n")
    patched = dataclasses.replace(
        isettings.get_instance_settings(),
        user_home=home,
        copilot_home=home / ".copilot",
        copilot_session_state_dir=sessions,
        copilot_config_path=home / ".copilot" / "config.json",
    )
    monkeypatch.setattr(isettings, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(ap, "get_instance_settings", lambda: patched)

    assert list(ap.iter_copilot_project_paths(include_temp=True)) == [project]


@pytest.mark.asyncio
async def test_get_all_projects_never_materializes_unsafe_home(
    project_db,
    tmp_path,
    monkeypatch,
):
    import dataclasses

    import flow_sdk.fs_store.operations.all_projects as ap
    import flow_sdk.instance_settings as isettings
    from flow_sdk.builtin.project import Project

    home = tmp_path / "home"
    project = home / "dev" / "repo"
    project.mkdir(parents=True)
    patched = dataclasses.replace(
        isettings.get_instance_settings(),
        user_home=home,
    )
    monkeypatch.setattr(isettings, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(ap, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(
        ap,
        "iter_claude_project_paths",
        lambda **kwargs: iter((home, project)),
    )
    monkeypatch.setattr(ap, "iter_codex_project_paths", lambda **kwargs: iter(()))
    monkeypatch.setattr(ap, "iter_copilot_project_paths", lambda **kwargs: iter(()))
    monkeypatch.setattr(ap, "iter_workspace_project_paths", lambda **kwargs: iter(()))

    projects = await ap.get_all_projects(include_temp=True, create_missing=True)

    assert [info.cwd for info in projects] == [str(project.resolve())]
    assert await Project.find_by_cwd(str(home)) is None
    assert await Project.find_by_cwd(str(project)) is not None


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_agent_mount_root_entity_is_not_returned(project_db, tmp_path, monkeypatch):
    """A stale Project entity minted for the agent mount ROOT itself (by a past
    ``recover_by_path`` before the guard) must not re-enter the canonical project
    list. A real work subfolder under the root stays a normal project."""
    import dataclasses

    import flow_sdk.config as cfg
    import flow_sdk.instance_settings as isettings
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    home = tmp_path / "home"
    ws = home / "Flowpad workspace"
    ws.mkdir(parents=True)
    records_root = tmp_path / "records"
    # The autouse records-root fixture redirects live record writers here, so
    # a background task from the shared test app may create it first.
    records_root.mkdir(exist_ok=True)

    patched = dataclasses.replace(
        isettings.get_instance_settings(),
        user_home=home,
        claude_projects_dir=home / ".claude" / "projects",
        codex_config_path=home / ".codex" / "config.toml",
        records_root=records_root,
    )
    import flow_sdk.fs_store.operations.all_projects as ap
    monkeypatch.setattr(ap, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(isettings, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(cfg, "AGENT_MOUNT_FOLDER", canonical_posix_path(ws))

    # Simulate the pre-guard stale entity sitting at the mount root, plus a real
    # work subfolder project under it (which must NOT be tagged hidden).
    stale = Project(
        name="Flowpad workspace",
        fs_storage_mount_path=canonical_posix_path(ws / "seed"),
    )
    # Bypass the new model backstop to reproduce a legacy persisted row.
    object.__setattr__(stale, "fs_storage_mount_path", canonical_posix_path(ws))
    stale.id = Project.allocate_id(stale.model_dump())
    await stale.save()
    sub = Project(name="real-project", fs_storage_mount_path=canonical_posix_path(ws / "real-project"))
    sub.id = Project.allocate_id(sub.model_dump())
    await sub.save()

    projects = await ap.get_all_projects(include_temp=True, create_missing=False)
    by_name = {p.name: p for p in projects}

    assert "Flowpad workspace" not in by_name, by_name
    assert "real-project" in by_name, by_name
    assert by_name["real-project"].system is False, "subfolder project must stay non-hidden"


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_is_hidden_project_predicate(tmp_path, monkeypatch):
    """``is_hidden_project`` hides on system flag OR system-project path OR the
    agent mount root; a normal subfolder is not hidden. Paths are validated via
    the workspace consts, never a hardcoded literal."""
    import flow_sdk.config as cfg
    from flow_sdk.config import is_hidden_project
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    ws = tmp_path / "home" / "Flowpad workspace"
    ws.mkdir(parents=True)
    monkeypatch.setattr(cfg, "AGENT_MOUNT_FOLDER", canonical_posix_path(ws))
    monkeypatch.setattr(cfg, "agent_workspace_root", lambda: ws)

    normal = tmp_path / "some" / "repo"
    normal.mkdir(parents=True)
    system_like = tmp_path / "flow_sdk" / "system_projects" / "flowpad_assistant"
    system_like.mkdir(parents=True)

    # system flag alone hides, regardless of path
    assert is_hidden_project(str(normal), system_flag=True) is True
    # structural system-project path hides
    assert is_hidden_project(str(system_like)) is True
    # the agent mount ROOT hides
    assert is_hidden_project(str(ws)) is True
    # a normal project (and a subfolder under the root) does not
    assert is_hidden_project(str(normal)) is False
    assert is_hidden_project(str(ws / "real-project")) is False


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_duplicate_mount_path_resolves_to_the_same_row_everywhere(
    project_db, tmp_path, monkeypatch
):
    """Two Project rows at ONE mount path must resolve to the SAME row through
    every reader.

    ``find_by_cwd`` and ``index_by_mount`` both document first-match; the scan
    here used to overwrite as it went, so it answered with the LAST row while
    every other caller got the FIRST. That disagreement is what let a session be
    labelled with one project id while the UI scope carried the other, and a
    project-scoped history list come back empty next to a panel listing the very
    same sessions.

    The duplicate itself is a separate defect (the find-then-create upsert has no
    uniqueness behind it, and
    ``migrations/migration_2026_09_duplicate_project_rows`` merges the rows it
    let through). Until a row is merged, the readers must at least agree.
    """
    import dataclasses

    import flow_sdk.fs_store.operations.all_projects as ap
    import flow_sdk.instance_settings as isettings
    from flow_sdk.builtin.project import Project
    from flow_sdk.fs_store.path_utils import canonical_posix_path

    home = tmp_path / "home"
    ws = home / "Flowpad workspace"
    ws.mkdir(parents=True)
    (ws / "twice").mkdir()
    records_root = tmp_path / "records"
    records_root.mkdir(exist_ok=True)
    patched = dataclasses.replace(
        isettings.get_instance_settings(),
        user_home=home,
        claude_projects_dir=home / ".claude" / "projects",
        codex_config_path=home / ".codex" / "config.toml",
        records_root=records_root,
    )
    monkeypatch.setattr(ap, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(isettings, "get_instance_settings", lambda: patched)

    cwd = canonical_posix_path(ws / "twice")
    first = Project.model_validate({"fs_storage_mount_path": cwd, "name": "twice"})
    first.id = Project.allocate_id(first.model_dump())
    await first.save()
    second = Project.model_validate({"fs_storage_mount_path": cwd, "name": "twice"})
    second.id = Project.allocate_id(second.model_dump())
    await second.save()
    assert first.id != second.id

    infos = await ap.get_all_projects(include_temp=True, create_missing=False)
    scanned = [i.project_id for i in infos if i.cwd == cwd]
    found = await Project.find_by_cwd(cwd)
    indexed = (await Project.index_by_mount()).get(cwd)

    assert len(scanned) == 1, scanned
    assert found is not None and indexed is not None
    assert scanned[0] == found.id == indexed.id
