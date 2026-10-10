"""Moving a project to another workspace (``Project.move_to_workspace``).

A workspace is a folder and membership is location, so a move is a folder move that
keeps the SAME row: the id survives, the row is re-pointed, the records indexed from
the old folder are dropped, the new folder gets a full index. Nothing is auto-suffixed:
a destination that already holds the name is refused (409), and so are the cases the
HTTP action maps to 400/404.

Drives the real SQLite persistence layer; the close-everything and index legs are
observed through seams (they need live workers / the indexer).
"""

# ruff: noqa: F811 — the `home` / `db` fixtures are imported from test_workspaces and taken as parameters

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.path_utils import canonical_posix_path
from tests.unit.test_workspaces import db, home  # noqa: F401 — fixtures

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.fixture
def quiet_move(monkeypatch):
    """Record the close + index legs instead of running them."""
    from flow_sdk.builtin.project import Project

    calls: dict[str, list] = {"close": [], "index": []}

    async def _close(self):
        calls["close"].append(str(self.id))

    async def _index(self):
        calls["index"].append(canonical_posix_path(self.fs_storage_mount_path))
        return True

    monkeypatch.setattr(Project, "close_all_open", _close)
    monkeypatch.setattr(Project, "_index_after_move", _index)
    return calls


async def _project_in(root: Path, name: str = "repo"):
    """A saved project with one file, in ``root`` (a workspace's folder)."""
    from flow_sdk.builtin.project import Project

    folder = root / name
    folder.mkdir(parents=True)
    (folder / "notes.md").write_text("# notes\n")
    project = Project(name=name, fs_storage_mount_path=str(folder))
    await project.save()
    return project, folder


async def _workspaces():
    from flow_sdk.builtin.workspace import Workspace

    await Workspace(name="Local Desktop Workspace", uname="local").save()
    return await Workspace.new("Client X")


@pytest.mark.asyncio
async def test_move_keeps_the_row_and_relocates_the_folder(home, db, quiet_move):
    from flow_sdk.builtin.project import Project
    from flow_sdk.config import workspace_id_for_path

    client = await _workspaces()
    project, old_folder = await _project_in(home / "Flowpad workspace")
    project_id = str(project.id)

    indexed = await project.move_to_workspace(client.id)

    new_folder = Path(client.folder) / "repo"
    assert indexed is True
    assert not old_folder.exists(), "a move leaves nothing behind"
    assert (new_folder / "notes.md").read_text() == "# notes\n"
    assert str(project.id) == project_id
    assert project.fs_storage_mount_path == canonical_posix_path(new_folder)
    assert workspace_id_for_path(new_folder) == str(client.id)
    # The row is found by its NEW path and no longer by the old one.
    assert await Project.find_by_cwd(str(old_folder)) is None
    found = await Project.find_by_cwd(str(new_folder))
    assert found is not None and str(found.id) == project_id
    # Close ran before the move, the index after it, at the new location.
    assert quiet_move["close"] == [project_id]
    assert quiet_move["index"] == [canonical_posix_path(new_folder)]


@pytest.mark.asyncio
async def test_move_back_to_the_default_workspace(home, db, quiet_move):
    client = await _workspaces()
    project, folder = await _project_in(Path(client.folder))

    await project.move_to_workspace(None)

    assert project.fs_storage_mount_path == canonical_posix_path(home / "Flowpad workspace" / "repo")
    assert not folder.exists()


@pytest.mark.asyncio
async def test_destination_with_that_name_is_refused(home, db, quiet_move):
    from flow_sdk.builtin.project import ProjectMoveError

    client = await _workspaces()
    project, old_folder = await _project_in(home / "Flowpad workspace")
    (Path(client.folder) / "repo").mkdir(parents=True)

    with pytest.raises(ProjectMoveError) as refused:
        await project.move_to_workspace(client.id)

    assert refused.value.status_code == 409
    assert old_folder.exists() and project.fs_storage_mount_path == canonical_posix_path(old_folder)
    assert quiet_move["close"] == [], "refused before anything was closed"


@pytest.mark.asyncio
async def test_already_there_and_unknown_workspace_are_refused(home, db, quiet_move):
    from flow_sdk.builtin.project import ProjectMoveError

    await _workspaces()
    project, _old = await _project_in(home / "Flowpad workspace")

    with pytest.raises(ProjectMoveError) as same:
        await project.move_to_workspace(None)
    assert same.value.status_code == 400

    with pytest.raises(ProjectMoveError) as unknown:
        await project.move_to_workspace("00000000-0000-4000-8000-000000000000")
    assert unknown.value.status_code == 404
    assert quiet_move["close"] == []


@pytest.mark.asyncio
async def test_a_project_without_a_folder_is_refused(home, db, quiet_move):
    from flow_sdk.builtin.project import Project, ProjectMoveError

    client = await _workspaces()
    project, folder = await _project_in(home / "Flowpad workspace")
    (folder / "notes.md").unlink()
    folder.rmdir()
    project = await Project.get_by_id(str(project.id))

    with pytest.raises(ProjectMoveError) as refused:
        await project.move_to_workspace(client.id)
    assert refused.value.status_code == 404


@pytest.mark.asyncio
async def test_unindex_folder_drops_only_records_from_that_folder(home, db):
    from flow_sdk.fs_store import get_default_records_root

    project, folder = await _project_in(home / "Flowpad workspace")
    other, _other_folder = await _project_in(home / "Flowpad workspace", "other")
    records_root = get_default_records_root()

    def shadow(rtype: str, rid: str, pid: str, asset: Path) -> Path:
        d = records_root / rtype / rid
        d.mkdir(parents=True)
        (d / "metadata.json").write_text(
            json.dumps({"type": rtype, "id": rid, "project_id": pid, "asset_ref": str(asset)})
        )
        return d

    inside = shadow("markdown", "11111111-1111-4111-8111-111111111111", str(project.id), folder / "notes.md")
    sibling = shadow("markdown", "22222222-2222-4222-8222-222222222222", str(project.id), folder.parent / "repo2" / "x.md")
    others = shadow("markdown", "33333333-3333-4333-8333-333333333333", str(other.id), folder / "notes.md")
    own = records_root / "project" / str(project.id)  # written by save()
    assert (own / "metadata.json").exists()

    dropped = await project.unindex_folder(str(folder))

    assert dropped == 1
    assert not inside.exists(), "the record indexed from the old folder is gone"
    assert sibling.exists(), "`/repo2` is not under `/repo` — segment-safe"
    assert others.exists(), "another project's record is not this project's"
    assert own.exists(), "the project's own record stays"


@pytest.mark.asyncio
async def test_a_project_on_the_temp_root_is_not_movable(home, db, quiet_move):
    """A row on a temp root is not a real work folder (``Project._visible``), so it
    cannot be moved — same answer as the picker, which never lists it."""
    import tempfile

    from flow_sdk.builtin.project import Project, ProjectMoveError

    client = await _workspaces()
    temp_root = Path(tempfile.gettempdir())
    project = Project(name="scratch", fs_storage_mount_path=str(temp_root))
    await project.save()

    with pytest.raises(ProjectMoveError) as refused:
        await project.move_to_workspace(client.id)
    assert refused.value.status_code == 400
    assert quiet_move["close"] == []


@pytest.mark.asyncio
async def test_an_index_that_did_not_run_is_reported_not_a_failed_move(home, db, monkeypatch):
    """The folder is moved and the row re-pointed before the index runs, so an index
    that does not run (seen live: an indexer that raised, a consent-gated root) answers
    ``False`` — the caller says "moved, rebuild the index" — never a failed move."""
    from flow_sdk.builtin.project import Project

    asked: list[dict] = []

    class _Node:
        async def _auto_index_project(self, project_id, **kwargs):
            asked.append({"project_id": project_id, **kwargs})
            return False

    async def _local(create=True):
        return _Node()

    async def _close(self):
        return None

    monkeypatch.setattr(Project, "close_all_open", _close)
    monkeypatch.setattr("flow_sdk.builtin.project.ComputeNode.get_local", _local)

    client = await _workspaces()
    project, old_folder = await _project_in(home / "Flowpad workspace")

    assert await project.move_to_workspace(client.id) is False

    assert not old_folder.exists()
    assert project.fs_storage_mount_path == canonical_posix_path(Path(client.folder) / "repo")
    # A full index, owed to this move: it waits for a running one instead of skipping.
    assert asked == [{"project_id": str(project.id), "force": True, "trigger": "switch-workspace", "queue": True}]
