"""A project CREATE that omits the mount must not relocate an existing project.

The zombie: `~/Flowpad workspace/flowpad-oss` kept reappearing for a checkout
that lives at `~/Documents/dev/flowpad-oss`. Captured on the live instance, the
writer is the generic create route — the frontend POSTs a project whose body
carries `id` + `name` but no `fs_storage_mount_path`, and
`handle_create_entity` re-validates that partial body from scratch:

    graph.py:335 handle_request
      -> graph_crud_actions.py:390 handle_create_entity
        -> entity_model.model_validate(sanitized_data)
          -> Project.set_fs_storage_mount_path "simple name" branch
             -> AGENT_MOUNT_FOLDER/<name>

Every project living OUTSIDE the agent workspace is silently moved into it, and
the next PTY spawn (`os.makedirs(cwd)`) materializes the folder — which is why
deleting it never stuck. (Projects already inside the workspace are immune: the
derivation reproduces their real path, so the bug is invisible for them.)

The same run emits `None API field !!!: visitor_role for entity type: project`
from this function's sanitize loop — the line present in the production log at
both observed flips, which is how this path was tied to the real incident.

Nothing about `Project` or the create handler is mocked. `request_info` is the
request CONTEXT (an input), supplied the way this repo's other handler tests do.
"""

import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.app.actions.graph_crud_actions import handle_create_entity
from flow_sdk.builtin.project import Project
from flow_sdk.config import AGENT_MOUNT_FOLDER
from flow_sdk.fs_store.type_id import TypeId

OWNER = TypeId("user-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")


def _create_request(body: dict) -> SimpleNamespace:
    """The request context for an unscoped `POST /api/v1/graph/project`.

    An explicit object rather than a MagicMock: a field this handler reads but
    the test forgot would otherwise become a Mock and land in a DB column as
    garbage instead of failing loudly.
    """
    return SimpleNamespace(
        direct_resource_type="project",
        get_post_data=AsyncMock(return_value=body),
        someone_typeid=OWNER,
        target_entity_typeid=None,   # unscoped create — no parent in the URL
        visitor_typeid=None,
        su=True,
        policies=SimpleNamespace(top_role="owner"),
        user=None,
        api_key=None,
        instance_counter=0,
        parent_entity=None,
    )


@pytest.mark.asyncio
async def test_create_with_partial_body_does_not_relocate_an_existing_project(tmp_path):
    """The body omits `fs_storage_mount_path`; the stored mount must survive."""
    real_dir = tmp_path / "Documents" / "dev" / "flowpad-oss"
    real_dir.mkdir(parents=True)

    project = Project(
        id=str(uuid.uuid4()),
        type="project",
        name="flowpad-oss",
        fs_storage_mount_path=str(real_dir),
    )
    await project.save()
    assert Path(project.fs_storage_mount_path).resolve() == real_dir.resolve()

    # Exactly the shape seen on the wire: id + name, no mount, plus the
    # non-API key whose rejection is logged in production.
    body = {
        "id": str(project.id),
        "type": "project",
        "name": "flowpad-oss",
        "visitor_role": "owner",
    }
    request = _create_request(body)
    with patch(
        "flow_sdk.app.actions.graph_crud_actions.get_current_request_info",
        return_value=request,
    ), patch(
        "flow_sdk.request_context.methods.get_current_request_info",
        return_value=request,
    ):
        await handle_create_entity(MagicMock())

    stored = await Project.get_by_id(str(project.id))
    assert stored is not None, "the project vanished on create"
    mount = Path(str(stored.fs_storage_mount_path)).resolve()
    workspace = Path(AGENT_MOUNT_FOLDER).resolve()

    assert workspace not in mount.parents, (
        f"zombie: a create that omitted the mount RELOCATED the project from "
        f"{str(real_dir)!r} into the agent workspace at {str(mount)!r}"
    )
    assert mount == real_dir.resolve()


@pytest.mark.asyncio
async def test_create_that_carries_the_mount_still_works(tmp_path):
    """Control: the same route with the mount in the body keeps working.

    Guards against a fix that stops the relocation by breaking creates.
    """
    real_dir = tmp_path / "Documents" / "dev" / "keeper"
    real_dir.mkdir(parents=True)

    body = {
        "type": "project",
        "name": "keeper",
        "fs_storage_mount_path": str(real_dir),
    }
    request = _create_request(body)
    with patch(
        "flow_sdk.app.actions.graph_crud_actions.get_current_request_info",
        return_value=request,
    ), patch(
        "flow_sdk.request_context.methods.get_current_request_info",
        return_value=request,
    ):
        response = await handle_create_entity(MagicMock())

    created = response.data
    assert Path(str(created.fs_storage_mount_path)).resolve() == real_dir.resolve()
