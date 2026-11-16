"""Deleting a project from the UI keeps its folder unless the user asked for it.

The delete dialog's "also delete the folder from disk" box is off by default, so
the route's default has to be the safe one: a request that says nothing about
the folder leaves it, and its files, where they are. Driven through the real
graph route (``POST project/<id>/delete-with-children``), not the method.
"""

import pytest

from flow_sdk.builtin.project import Project
from tests.unit._graph_client import call_local


async def _project_with_a_file(tmp_path) -> tuple[Project, object]:
    folder = tmp_path / "work"
    folder.mkdir()
    (folder / "notes.md").write_text("the user's own file")
    project = await Project(name=f"delete-folder-{tmp_path.name}", fs_storage_mount_path=str(folder)).save()
    return project, folder


async def _delete(project: Project, body: dict):
    return await call_local("POST", f"project/{project.id}/delete-with-children", json=body)


@pytest.mark.asyncio
async def test_a_delete_that_does_not_ask_for_the_folder_keeps_it(tmp_path):
    project, folder = await _project_with_a_file(tmp_path)

    response = await _delete(project, {"delete_chats": False})

    assert response.status_code == 200, response.text
    assert await Project.get_by_id(str(project.id)) is None
    assert (folder / "notes.md").read_text() == "the user's own file"


@pytest.mark.asyncio
async def test_delete_folder_false_keeps_it(tmp_path):
    project, folder = await _project_with_a_file(tmp_path)

    response = await _delete(project, {"delete_chats": False, "delete_folder": False})

    assert response.status_code == 200, response.text
    assert await Project.get_by_id(str(project.id)) is None
    assert (folder / "notes.md").exists()


@pytest.mark.asyncio
async def test_delete_folder_true_removes_it(tmp_path):
    project, folder = await _project_with_a_file(tmp_path)

    response = await _delete(project, {"delete_chats": False, "delete_folder": True})

    assert response.status_code == 200, response.text
    assert await Project.get_by_id(str(project.id)) is None
    assert not folder.exists()


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["true", 1, None])
async def test_a_non_boolean_delete_folder_is_refused_and_deletes_nothing(tmp_path, value):
    # A truthy string must not be read as consent to remove the user's files.
    project, folder = await _project_with_a_file(tmp_path)

    response = await _delete(project, {"delete_chats": False, "delete_folder": value})

    assert response.status_code == 400, response.text
    assert await Project.get_by_id(str(project.id)) is not None
    assert (folder / "notes.md").exists()


async def _move(project: Project, mount) -> None:
    # Nesting is refused only when a project is created; a moved (or legacy) row can still overlap.
    project.fs_storage_mount_path = str(mount)
    await project.save()


@pytest.mark.asyncio
@pytest.mark.parametrize("where", ["inside", "around"])
async def test_a_folder_shared_with_another_project_is_refused_and_nothing_is_deleted(tmp_path, where):
    project, folder = await _project_with_a_file(tmp_path)
    other = await Project(name=f"other-{tmp_path.name}", fs_storage_mount_path=str(tmp_path / "elsewhere")).save()
    await _move(other, folder / "sub" if where == "inside" else tmp_path)

    response = await _delete(project, {"delete_chats": False, "delete_folder": True})

    assert response.status_code == 409, response.text
    assert "shared with other projects" in response.text
    assert await Project.get_by_id(str(project.id)) is not None
    assert (folder / "notes.md").exists()

