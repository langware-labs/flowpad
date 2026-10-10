"""Workspaces — folders of related projects.

A project belongs to the user-created workspace whose root contains it; everything
else belongs to the default workspace (this instance's ``workspace_root``). With no
user-created workspace every reader answers exactly what it answered before
workspaces existed — that backward-compatibility contract is asserted first.

Drives the real SQLite persistence layer (no mocks of save/query).
"""

import dataclasses
from pathlib import Path

import pytest
import pytest_asyncio

import flow_sdk.builtin.faas.project_list as project_list
import flow_sdk.config as cfg
import flow_sdk.db.drivers.db_driver as db_driver_mod
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver
from flow_sdk.fs_store.path_utils import canonical_posix_path


@pytest.fixture(autouse=True)
def _no_workspaces_leak():
    """The root registry is module state; no test may inherit or leak one."""
    cfg.set_workspace_roots({})
    project_list.invalidate_project_list_cache()
    yield
    cfg.set_workspace_roots({})
    project_list.invalidate_project_list_cache()


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A sandbox ``user_home`` with its default workspace root; settings follow it."""
    import flow_sdk.instance_settings as isettings

    home = tmp_path / "home"
    default_root = home / "Flowpad workspace"
    default_root.mkdir(parents=True)
    records_root = tmp_path / "records"
    records_root.mkdir(exist_ok=True)
    # The default root ``~/Flowpad workspace`` is prod's layout (any other instance keeps its workspaces
    # under ``~/Flowpad workspaces``), so the sandbox pins the instance: the shell's FLOW_INSTANCE never decides.
    patched = dataclasses.replace(
        isettings.get_instance_settings(),
        instance_name="prod",
        user_home=home,
        claude_projects_dir=home / ".claude" / "projects",
        codex_config_path=home / ".codex" / "config.toml",
        records_root=records_root,
    )
    import flow_sdk.fs_store.operations.all_projects as ap

    monkeypatch.setattr(ap, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(isettings, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(cfg, "agent_workspace_root", lambda: default_root)
    # The root registry is module state. The sandbox clears it on the way out as well, so a module that
    # borrows this fixture (and so never gets ``_no_workspaces_leak``) cannot hand its workspaces on.
    yield home
    cfg.set_workspace_roots({})
    project_list.invalidate_project_list_cache()


@pytest_asyncio.fixture
async def db(tmp_path):
    """Isolated SQLite driver with the ``project`` and ``workspace`` types registered."""
    config = DBConfig()
    config.database = str(tmp_path / "workspaces.db")
    driver = SQLiteDBDriver(config)
    await driver.open()

    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.schema.entity_factory import type_registry

    if type_registry.get("project") is None:
        from flow_sdk.builtin.project import Project

        type_registry.register("project", Project)
    if type_registry.get("workspace") is None:
        from flow_sdk.builtin.workspace import Workspace

        type_registry.register("workspace", Workspace)

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


# -- backward compatibility: no user-created workspace == before workspaces ----------


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_no_workspaces_changes_nothing(home):
    default_root = home / "Flowpad workspace"
    (default_root / "proj_a").mkdir()
    elsewhere = home / "Documents" / "dev" / "repo"
    elsewhere.mkdir(parents=True)

    from flow_sdk.config import all_workspace_roots, is_agent_mount_root, workspace_id_for_path
    from flow_sdk.fs_store.operations.all_projects import iter_workspace_project_paths
    from flow_sdk.fs_store.path_utils import is_protected_path

    assert all_workspace_roots() == [default_root]
    assert workspace_id_for_path(default_root / "proj_a") is None
    assert workspace_id_for_path(elsewhere) is None
    assert cfg.workspace_root_for_id(None) == default_root
    assert cfg.workspace_root_for_id("local") == default_root
    assert cfg.workspace_root_for_id("no-such-workspace") is None
    assert [p.name for p in iter_workspace_project_paths(include_temp=True)] == ["proj_a"]
    assert is_protected_path(default_root) is True
    assert is_protected_path(default_root / "proj_a") is False
    assert is_agent_mount_root(default_root) is True


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_workspaces_home_per_instance(tmp_path):
    """prod's new workspaces go to ``~/Flowpad``; any other instance stays out of the
    user's area and out of every instance root (``~/Flowpad workspaces/<name>``)."""
    import flow_sdk.instance_settings as isettings
    from flow_sdk.instance_settings.base_settings import BaseInstanceSettings

    base = isettings.get_instance_settings()
    prod = dataclasses.replace(base, instance_name="prod", user_home=tmp_path)
    dev = dataclasses.replace(base, instance_name="dev-1", user_home=tmp_path)
    assert BaseInstanceSettings.workspaces_home.fget(prod) == tmp_path / "Flowpad"
    dev_home = BaseInstanceSettings.workspaces_home.fget(dev)
    assert dev_home == tmp_path / "Flowpad workspaces" / ".workspaces" / "dev-1"
    assert not dev_home.is_relative_to(BaseInstanceSettings.workspace_root.fget(dev))


# -- the root registry -------------------------------------------------------------


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_membership_is_by_location(home):
    client = home / "Flowpad" / "Client X"
    (client / "site").mkdir(parents=True)
    (home / "Flowpad workspace" / "proj_a").mkdir()
    cfg.set_workspace_roots({"ws-1": str(client)})

    assert cfg.workspace_id_for_path(client / "site") == "ws-1"
    assert cfg.workspace_id_for_path(client) == "ws-1"
    # A sibling whose name only STARTS like the root is not inside it.
    (home / "Flowpad" / "Client X2").mkdir()
    assert cfg.workspace_id_for_path(home / "Flowpad" / "Client X2") is None
    assert cfg.workspace_id_for_path(home / "Flowpad workspace" / "proj_a") is None
    assert cfg.workspace_root_for_id("ws-1") == Path(canonical_posix_path(client))
    assert [Path(r) for r in map(str, cfg.all_workspace_roots())] == [
        home / "Flowpad workspace",
        Path(canonical_posix_path(client)),
    ]


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_every_root_is_guarded_and_scanned(home):
    from flow_sdk.config import is_agent_mount_root, is_hidden_project
    from flow_sdk.fs_store.operations.all_projects import iter_workspace_project_paths
    from flow_sdk.fs_store.operations.project_cleanup import CleanupRefused, guard_deletable
    from flow_sdk.fs_store.path_utils import is_protected_path

    client = home / "Flowpad" / "Client X"
    (client / "site").mkdir(parents=True)
    (client / ".flow").mkdir()
    (home / "Flowpad workspace" / "proj_a").mkdir()
    cfg.set_workspace_roots({"ws-1": str(client)})

    assert sorted(p.name for p in iter_workspace_project_paths(include_temp=True)) == ["proj_a", "site"]
    assert is_protected_path(client) is True
    assert is_protected_path(client / "site") is False
    assert is_agent_mount_root(client) is True
    assert is_hidden_project(client) is True
    assert is_hidden_project(client / "site") is False
    with pytest.raises(CleanupRefused):
        guard_deletable(str(client))
    assert guard_deletable(str(client / "site")) == Path(canonical_posix_path(client / "site"))


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_windows_root_is_protected_from_posix(monkeypatch):
    """A Windows workspace root keeps Windows semantics (drive, case-folding) even
    when the policy is evaluated on another OS — the same contract as the default root."""
    from flow_sdk.fs_store.path_utils import is_protected_path

    cfg.set_workspace_roots({"ws-win": "C:/Users/alice/Flowpad/Client X"})
    assert cfg.workspace_id_for_path("c:\\users\\ALICE\\flowpad\\client x\\site") == "ws-win"
    assert cfg.workspace_id_for_path("C:/Users/alice/Flowpad/Client X2/site") is None
    assert is_protected_path("C:\\Users\\alice\\Flowpad\\Client X") is True
    assert is_protected_path("c:/users/ALICE/flowpad/client x") is True
    assert is_protected_path("C:\\Users\\alice\\Flowpad\\Client X\\site") is False


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_placement_takes_a_workspace_base(home):
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.fs_store.origin.git_origin import fresh_clone_slot

    client = home / "Flowpad" / "Client X"
    client.mkdir(parents=True)
    cfg.set_workspace_roots({"ws-1": str(client)})

    assert fresh_clone_slot("site").parent == home / "Flowpad workspace"
    assert fresh_clone_slot("site", base=client).parent == client
    (client / "site").mkdir()
    (client / "site" / "x").write_text("x")
    assert ComputeNode._next_free_leaf("site", base=str(client)) == "site-2"
    assert ComputeNode._next_free_leaf("site") == "site"  # the default root has none



@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_placement_names_its_workspace(db, home):
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    from flow_sdk.builtin.workspace import Workspace

    default = Workspace(name="Local Desktop Workspace", uname="local")
    await default.save()
    client = await Workspace.new("Client X")

    root, error = ComputeNode._workspace_base({})
    assert (root, error) == (str(home / "Flowpad workspace"), None)
    root, error = ComputeNode._workspace_base({"workspace": str(client.id)})
    assert (Path(root), error) == (Path(client.root_path), None)
    # The default workspace by its id (what the UI sends once a second one exists) or uname.
    for named in (str(default.id), "local"):
        root, error = ComputeNode._workspace_base({"workspace": named})
        assert (root, error) == (str(home / "Flowpad workspace"), None)
    _root, error = ComputeNode._workspace_base({"workspace": "8b0c3c1e-0000-4000-8000-000000000000"})
    assert error is not None and error.status_code == 404


# -- the Workspace entity ----------------------------------------------------------


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_create_rename_delete(db, home):
    from flow_sdk.builtin.workspace import Workspace, WorkspaceRootError

    workspace = await Workspace.new("Client X")
    expected = Path(canonical_posix_path(home / "Flowpad" / "Client X"))
    assert Path(workspace.root_path) == expected and expected.is_dir()
    assert workspace.is_default is False
    assert workspace.root == canonical_posix_path(expected).lstrip("/")
    assert cfg.extra_workspace_roots() == {str(workspace.id): str(expected)}

    workspace.name = "Client Y"
    await workspace.save()
    reloaded = await Workspace.get_by_id(workspace.id)
    assert reloaded.name == "Client Y" and Path(reloaded.root_path) == expected

    reloaded.root_path = str(home / "Flowpad" / "elsewhere")
    with pytest.raises(WorkspaceRootError):
        await reloaded.save()

    await Workspace.delete_by_id(workspace.id)
    assert cfg.extra_workspace_roots() == {}
    assert expected.is_dir(), "deleting a workspace must never delete its folder"


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_default_workspace_is_the_instance_root(db, home):
    from flow_sdk.builtin.workspace import Workspace, WorkspaceRootError

    default = Workspace(name="Local Desktop Workspace", uname="local")
    await default.save()
    assert default.root_path is None, "the default workspace's root is resolved, never stored"
    assert default.is_default is True and default.display_name == "Flowpad"
    assert default.root == canonical_posix_path(home / "Flowpad workspace").lstrip("/")
    assert cfg.extra_workspace_roots() == {}
    with pytest.raises(WorkspaceRootError):
        await Workspace.delete_by_id(default.id)
    assert (await Workspace.default()).id == default.id


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_bad_roots_are_refused(db, home):
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.workspace import Workspace, WorkspaceRootError

    first = await Workspace.new("Client X")
    project_dir = home / "Documents" / "repo"
    project_dir.mkdir(parents=True)
    project = Project(name="repo", fs_storage_mount_path=str(project_dir))
    project.id = Project.allocate_id(project.model_dump())
    await project.save()

    for bad in (
        home,  # the user's home is protected
        home / "Flowpad workspace" / "nested",  # inside the default root: it would be a project
        Path(first.root_path) / "inner",  # inside another workspace
        home / "Flowpad",  # contains another workspace
        project_dir / "sub",  # inside a project
    ):
        with pytest.raises(WorkspaceRootError):
            await Workspace.new("bad", root_path=bad)
    assert len(cfg.extra_workspace_roots()) == 1

    # A folder that already HOLDS projects is fine — they join the workspace.
    adopted = await Workspace.new("Documents", root_path=home / "Documents")
    assert [p.name for p in await adopted.projects()] == ["repo"]
    assert (await Workspace.for_path(project_dir)).id == adopted.id


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_load_roots_reads_the_rows(db, home):
    from flow_sdk.builtin.workspace import Workspace

    workspace = await Workspace.new("Client X")
    cfg.set_workspace_roots({})
    await Workspace.load_roots()
    assert list(cfg.extra_workspace_roots()) == [str(workspace.id)]


# -- list-projects ---------------------------------------------------------------


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_list_projects_filters_by_workspace(db, home, monkeypatch):
    import flow_sdk.fs_store.operations.all_projects as ap

    client = home / "Flowpad" / "Client X"
    (client / "site").mkdir(parents=True)
    (home / "Flowpad workspace" / "proj_a").mkdir()
    cfg.set_workspace_roots({"ws-1": str(client)})

    monkeypatch.setattr(ap, "iter_claude_project_paths", lambda **kwargs: iter(()))
    monkeypatch.setattr(ap, "iter_codex_project_paths", lambda **kwargs: iter(()))
    monkeypatch.setattr(ap, "iter_copilot_project_paths", lambda **kwargs: iter(()))
    real_scan = ap.scan_project_cwds
    real_join = ap.join_projects
    monkeypatch.setattr(ap, "scan_project_cwds", lambda: real_scan(include_temp=True))

    async def join(scanned, *, create_missing):
        return await real_join(scanned, include_temp=True, create_missing=create_missing)

    monkeypatch.setattr(ap, "join_projects", join)
    monkeypatch.setattr(project_list, "is_valid_project_cwd", lambda _cwd: True)
    monkeypatch.setattr(project_list, "_codex_activity_by_cwd", lambda: {})
    monkeypatch.setattr(project_list, "_copilot_activity_by_cwd", lambda: {})
    monkeypatch.setattr(project_list, "_index_claude_dirs_by_cwd", lambda _root: {})

    def names(listing):
        return sorted(Path(row["cwd"]).name for row in listing["projects"])

    everything = await project_list.list_projects_from_indexer()
    assert names(everything) == ["proj_a", "site"]
    assert names(await project_list.list_projects_from_indexer(workspace="ws-1")) == ["site"]
    assert names(await project_list.list_projects_from_indexer(workspace="local")) == ["proj_a"]

    # A new workspace holds nothing: like a fresh install.
    empty = home / "Flowpad" / "Empty"
    empty.mkdir()
    cfg.set_workspace_roots({"ws-1": str(client), "ws-2": str(empty)})
    project_list.invalidate_project_list_cache()
    assert names(await project_list.list_projects_from_indexer(workspace="ws-2")) == []


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_bootstrap_lists_workspaces_with_their_folders(db, home):
    """The bootstrap's list is what the UI's loaders read before the workspace list is
    fetched, so it must carry the folder and the default flag, not just identity."""
    from flow_sdk.builtin.workspace import Workspace
    from flow_sdk.server.routes.bootstrap import workspace_to_dict

    default = Workspace(name="Local Desktop Workspace", uname="local")
    await default.save()
    client = await Workspace.new("Client X")

    rows = [workspace_to_dict(w) for w in await Workspace.all_workspaces()]
    assert [(r["id"], r["is_default"]) for r in rows] == [(default.id, True), (client.id, False)]
    assert rows[0]["root_path"] is None
    assert rows[0]["root"] == canonical_posix_path(home / "Flowpad workspace").lstrip("/")
    assert rows[1]["root_path"] == client.root_path
