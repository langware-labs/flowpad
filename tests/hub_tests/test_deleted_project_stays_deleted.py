"""Live-hub: a project deleted here is not brought back by its own conversation.

Deleting a project takes its conversations with it locally; the hub still holds
them. The next catch-up re-syncs their messages, and a message that references
the project (``project-<id>``) made ``mirror_referenced_projects`` hydrate it from
the hub again — so the project the user just deleted reappeared, holding its name.
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

# Wire the full entity registry. Pytest does not run the server startup path.
import flow_sdk.models.entities  # noqa: F401
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.builtin.project import Project
from flow_sdk.schema.types import EntityType

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.deleted_project_returns.rules: FAILING? Read this tag's rules
#       before editing; a project the user deleted must not be hydrated back from the
#       hub by its conversation's messages. Needs the local hub and two identities.
# flowpad:endcapsule tag
async def test_a_deleted_project_is_not_rehydrated_by_its_conversation(
    tmp_path: Path,
    hub_base_url,
    hub_login_payload,
    isolated_hub_keyring,
) -> None:
    from flow_sdk.app.actions.flow_message_action import _fetch_conversation_messages
    from tests.hub_tests._local_login import login_as

    login_as(hub_login_payload)

    root = tmp_path / "doomed"
    root.mkdir()
    project = await Project(name=f"doomed-{int(time.time())}", fs_storage_mount_path=str(root)).save(notify=False)
    await project.share()

    conv = Conversation(title=f"doomed-conv-{int(time.time())}", project_id=project.id)
    await conv.share()
    data = await conv.add_message(
        "the project",
        attachments=[
            {"attachment_type": AttachmentType.TYPE_ID.value, "data": f"{EntityType.PROJECT.value}-{project.id}"}
        ],
    )
    fm_id = data["id"]

    await project._delete_with_children(folder="keep", delete_chats=False)
    assert await Project.get_one({"id": project.id}) is None
    assert await FlowMessage.get_one({"id": fm_id}) is None, "precondition: the delete took the conversation's message"

    # The catch-up that runs for every conversation the hub still lists.
    await _fetch_conversation_messages(conv.id, None)

    assert await FlowMessage.get_one({"id": fm_id}) is not None, "precondition: catch-up re-synced the message"
    assert await Project.get_one({"id": project.id}) is None, "deleted project came back from the hub"
