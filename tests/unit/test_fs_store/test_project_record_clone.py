"""One folder, one project — through the official create route.

The UI opens a folder as a project with ``new Project({name: <path>}).save()``,
i.e. an unscoped ``POST /api/v1/graph/project``. Doing that twice for the same
folder must not leave two Project rows: ``handle_create_entity`` validates,
``allocate_id`` mints a fresh uuid4, and ``Project.save`` only *warns* when the
folder is already owned — so every repeat create is a new duplicate row.

Nothing about ``Project`` or the create handler is mocked; ``request_info`` is
the request CONTEXT (an input), supplied the way
``test_project_create_preserves_mount.py`` does.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions.graph_crud_actions import handle_create_entity
from flow_sdk.builtin.project import Project
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.fs_store.type_id import TypeId

OWNER = TypeId("user-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")


def _create_request(body: dict) -> SimpleNamespace:
    """Request context for an unscoped ``POST /api/v1/graph/project``."""
    return SimpleNamespace(
        direct_resource_type="project",
        get_post_data=AsyncMock(return_value=body),
        someone_typeid=OWNER,
        target_entity_typeid=None,
        visitor_typeid=None,
        su=True,
        policies=SimpleNamespace(top_role="owner"),
        user=None,
        api_key=None,
        instance_counter=0,
        parent_entity=None,
    )


async def _post_project(body: dict) -> Project:
    request = _create_request(body)
    with patch(
        "flow_sdk.app.actions.graph_crud_actions.get_current_request_info",
        return_value=request,
    ), patch(
        "flow_sdk.request_context.methods.get_current_request_info",
        return_value=request,
    ):
        return (await handle_create_entity(request=None)).data


@pytest.mark.asyncio
async def test_opening_the_same_folder_twice_yields_one_project(sync_db, tmp_path) -> None:
    folder = tmp_path / "Documents" / "dev" / "flowpad-oss"
    folder.mkdir(parents=True)
    body = {"type": "project", "name": str(folder)}  # use-open-project.ts's body

    first = await _post_project(dict(body))
    second = await _post_project(dict(body))

    owners = sorted(
        str(p.id)
        for p in await Project.get_all()
        if p.fs_storage_mount_path and canonical_posix_path(p.fs_storage_mount_path) == canonical_posix_path(str(folder))
    )
    assert owners == [str(first.id)], f"one folder, {len(owners)} projects: first={first.id} second={second.id}"
