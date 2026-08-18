"""Driven test: workspace-folder discovery in ``get_all_projects``.

Every non-hidden top-level folder under ``<user_home>/Flowpad workspace`` must
be discovered, minted a stable v5 id, and materialized as a persisted Project
entity — the exact same reconcile → mint → materialize path Claude/Codex
cwds take. Drives the real SQLite persistence layer (no mocks of save/query).
"""

import uuid

import pytest
import pytest_asyncio

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
    from flow_sdk.fs_store.identifier import is_valid_entity_id
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


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_project_picker_listing_discovers_paths_without_materializing_them(
    project_db,
    tmp_path,
    monkeypatch,
):
    """The picker returns discovered cwds but never bulk-creates Project rows."""
    import flow_sdk.builtin.faas.project_list as project_list
    import flow_sdk.fs_store.operations.all_projects as ap
    from flow_sdk.builtin.project import Project

    discovered = tmp_path / "historical-worker-project"
    discovered.mkdir()
    monkeypatch.setattr(ap, "iter_claude_project_paths", lambda **kwargs: iter(()))
    monkeypatch.setattr(ap, "iter_codex_project_paths", lambda **kwargs: iter(()))
    monkeypatch.setattr(ap, "iter_copilot_project_paths", lambda **kwargs: iter(()))
    monkeypatch.setattr(ap, "iter_workspace_project_paths", lambda **kwargs: iter((discovered,)))

    real_get_all_projects = ap.get_all_projects

    async def read_only_projects(*, create_missing):
        assert create_missing is False
        return await real_get_all_projects(include_temp=True, create_missing=create_missing)

    monkeypatch.setattr(ap, "get_all_projects", read_only_projects)
    monkeypatch.setattr(project_list, "is_valid_project_cwd", lambda _cwd: True)
    monkeypatch.setattr(project_list, "_codex_activity_by_cwd", lambda: {})
    monkeypatch.setattr(project_list, "_copilot_activity_by_cwd", lambda: {})
    monkeypatch.setattr(project_list, "_index_claude_dirs_by_cwd", lambda _root: {})

    before = await Project.get_all()
    result = await project_list.list_projects_from_indexer()
    after = await Project.get_all()

    assert [row["cwd"] for row in result["projects"]] == [str(discovered.resolve())]
    assert after == before == []
    assert await Project.find_by_cwd(str(discovered.resolve())) is None


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
