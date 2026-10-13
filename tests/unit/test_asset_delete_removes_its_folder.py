"""Deleting a file-backed asset must leave nothing for the Assets menu to count.

Seen on the live instance: project `waha` showed `Agents 1` over an "Empty"
list. The badge is the project menu (`build_asset_menu`, a walk of the files on
disk); the list is the index. The Assets row's trash button calls
`DELETE /api/v1/graph/agent/<id>`:

    graph_crud_actions.handle_delete_by_id
      -> Entity.delete_by_id
        -> sqlite_driver.delete_by_id      (rows + relationships only)

so the row goes and `agentic-assets/agent/<name>/` stays, counted forever.

Nothing about `Agent`, `Project`, the handlers or the menu is mocked.
`request_info` is the request CONTEXT (an input), supplied the way
`test_project_create_preserves_mount.py` does.
"""

import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.app.actions.graph_crud_actions import handle_create_entity, handle_delete_by_id
from flow_sdk.builtin.asset_menu import build_asset_menu
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.type_id import TypeId
from tests.unit._project_names import unique_project_name

OWNER = TypeId("user-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")


def _request(*, resource_type: str, target: TypeId, parent=None, body: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(
        direct_resource_type=resource_type,
        get_post_data=AsyncMock(return_value=body or {}),
        someone_typeid=OWNER,
        target_entity_typeid=target,
        visitor_typeid=None,
        su=True,
        policies=SimpleNamespace(top_role="owner"),
        user=None,
        api_key=None,
        instance_counter=0,
        parent_entity=parent,
        get_target_entity=AsyncMock(return_value=parent),
    )


async def _call(handler, request: SimpleNamespace):
    with patch(
        "flow_sdk.app.actions.graph_crud_actions.get_current_request_info", return_value=request
    ), patch("flow_sdk.request_context.methods.get_current_request_info", return_value=request):
        return await handler()


async def _agent_count(project: Project) -> int:
    menu = await build_asset_menu(project)
    return next((g.count for g in menu.root.groups if g.type_name == "agent"), 0)


@pytest.mark.asyncio
async def test_deleting_an_agent_removes_its_folder_and_its_menu_count(tmp_path: Path):
    root = tmp_path / "waha"
    root.mkdir()
    project = Project(id=str(uuid.uuid4()), name=unique_project_name("waha"), fs_storage_mount_path=str(root))
    await project.save()

    # POST /api/v1/graph/project/<id>/agent  — the Assets "+" button.
    created = await _call(
        lambda: handle_create_entity(MagicMock()),
        _request(resource_type="agent", target=project.typeid, parent=project, body={"name": "W"}),
    )
    agent = created.data
    folder = root / "agentic-assets" / "agent" / "w"
    assert (folder / "agent.json").is_file(), "the create did not write the agent's folder"
    assert await _agent_count(project) == 1

    # DELETE /api/v1/graph/agent/<id>  — the Assets row's trash button.
    await _call(handle_delete_by_id, _request(resource_type="agent", target=agent.typeid))

    assert not folder.exists(), f"the agent row is deleted but its folder is still on disk: {sorted(p.name for p in folder.iterdir())}"
    assert await _agent_count(project) == 0, "the Assets menu still counts the deleted agent"


@pytest.mark.asyncio
async def test_deleting_a_prompt_removes_its_file(tmp_path: Path):
    """A prompt is one file, not a folder — the same promise, a different shape."""
    root = tmp_path / "notes"
    root.mkdir()
    project = Project(id=str(uuid.uuid4()), name=unique_project_name("notes"), fs_storage_mount_path=str(root))
    await project.save()

    created = await _call(
        lambda: handle_create_entity(MagicMock()),
        _request(resource_type="prompt", target=project.typeid, parent=project, body={"name": "greet", "text": "Say hi."}),
    )
    prompt = created.data
    file = Path(prompt.asset_ref)
    assert file.is_file() and root in file.parents, f"the create did not write the prompt's file: {file}"

    await _call(handle_delete_by_id, _request(resource_type="prompt", target=prompt.typeid))

    assert not file.exists(), "the prompt row is deleted but its file is still on disk"
