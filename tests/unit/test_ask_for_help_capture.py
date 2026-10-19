"""``ask-for-help`` writes the request HERE first — whatever the hub, the network or sign-in say.

The hub hop is the one seam replaced (``Conversation.deliver``); capture is the real action.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import ask_for_help_action as afh
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.task import Task
from flow_sdk.db.drivers.query import QueryFilter
from flow_sdk.server.routes.bootstrap import get_or_create_local_user

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def task_storage(tmp_path):
    """Somewhere for a task's folder to live — the server gives a request one."""
    from flow_sdk.request_context import methods as ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    yield
    ctx.set_default_test_storage_fallback(None)


async def _ask(body: dict):
    someone = (await get_or_create_local_user()).typeid
    request = SimpleNamespace(someone_typeid=someone, get_post_data=AsyncMock(return_value=body))
    with (
        patch.object(afh, "get_current_request_info", return_value=request),
        patch.object(Conversation, "deliver", AsyncMock()),  # the hub is elsewhere's concern
        patch.object(Conversation, "kick_delivery", lambda *_a, **_k: None),
    ):
        return await afh.ask_for_help()


async def _messages(conv_id: str) -> list[FlowMessage]:
    return await FlowMessage.get_all(QueryFilter(match={"conversation_id": conv_id}))


async def test_asking_a_person_writes_the_task_the_conversation_and_the_message():
    conv_id = str(uuid.uuid4())
    body = {"conversation_id": conv_id, "recipient": {"kind": "person", "email": "dana@x.test"}, "text": "help me ship"}

    response = await _ask(body)

    assert response.data["conversation_id"] == conv_id
    task = await Task.get_one({"id": response.data["task_id"]})
    assert task.origin_conversation == conv_id and task.assignee == "dana@x.test" and task.kind == "vibe"
    conv = await Conversation.get_one({"id": conv_id})
    assert conv.awaits_hub, "captured for the hub, not there yet"
    assert [m.text for m in await _messages(conv_id)] == ["help me ship"]


async def test_the_same_request_sent_again_writes_nothing_new():
    body = {
        "conversation_id": str(uuid.uuid4()),
        "recipient": {"kind": "person", "email": "dana@x.test"},
        "text": "again",
    }

    first, again = await _ask(body), await _ask(body)

    assert (first.data["task_id"], first.data["message_id"]) == (again.data["task_id"], again.data["message_id"])
    assert len(await _messages(body["conversation_id"])) == 1


async def test_a_desk_ask_with_no_desk_known_yet_is_kept_for_delivery():
    with patch("flow_sdk.app.actions.flow_message_action._last_known_desk", return_value=None):
        response = await _ask({"recipient": {"kind": "desk"}, "text": "offline on a fresh install"})

    conv = await Conversation.get_one({"id": response.data["conversation_id"]})
    assert conv.kind == "helpdesk" and conv.remote_project_id is None and conv.awaits_hub


async def test_a_person_needs_an_address():
    response = await _ask({"recipient": {"kind": "person"}, "text": "to whom?"})
    assert response.status_code == 400
