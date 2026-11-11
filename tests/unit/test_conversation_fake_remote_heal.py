"""A conversation holding words written here that claims a hub counterpart this account cannot reach is
demoted to a local conversation — never 403'd forever, never pruned away.

How such a row is born: ``Entity.share`` once took a hub 409 on someone else's row as
"already ours" (see ``test_entity_share_idempotent``). Rows written that way still exist.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.cloud_client.hub_proxy import HubProxy, HubWalk

_HIDDEN = '{"status":"FAIL","message":"Missing request info(Target entity not found)","data":{"error_code":"target_not_found"}}'


@pytest.fixture()
def hub_hides_every_row(monkeypatch):
    """The hub's one network hop answers what it answered Ami: 403 target_not_found."""
    monkeypatch.setattr(
        "flow_sdk.cli.auth.credentials.load_credentials",
        lambda: SimpleNamespace(api_key="test-key", is_expired=lambda *_a: False),
    )

    async def fake_send(method, url, **kwargs):
        return httpx.Response(
            403, text=_HIDDEN, headers={"content-type": "application/json"}, request=httpx.Request(method, str(url))
        )

    monkeypatch.setattr(HubProxy, "send", staticmethod(fake_send))


async def _rows():
    """One conversation holding a message this machine wrote, one mirrored from someone else."""
    mine = await Conversation(id=mint_uuid(), remote=True, title="mine").save()
    await FlowMessage(id=mint_uuid(), conversation_id=mine.id, text="my words", outbound=True).save()
    theirs = await Conversation(id=mint_uuid(), remote=True, title="theirs").save()
    await FlowMessage(id=mint_uuid(), conversation_id=theirs.id, text="their words").save()
    return mine, theirs


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_message_sync_demotes_my_conversation_the_hub_cannot_show(hub_hides_every_row):
    mine, theirs = await _rows()

    for conv in (mine, theirs):
        assert await fma._fetch_conversation_messages(conv.id, "user-x") is False

    assert (await Conversation.get_by_id(mine.id)).remote is False
    assert (await Conversation.get_by_id(theirs.id)).remote is True  # not ours to judge


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_conversation_list_keeps_my_conversation_and_prunes_a_mirror():
    mine, theirs = await _rows()

    with (
        patch.object(HubProxy, "walk", new=AsyncMock(return_value=HubWalk(rows=[], complete=True))),
        patch.object(HubProxy, "try_call", new=AsyncMock(return_value=[])),
        patch.object(fma, "hub_base_url", return_value="https://hub.test"),
        patch("flow_sdk.cli.auth.hub_login.hub_auth_available", return_value=True),
    ):
        await fma.handle_conversation_list(SimpleNamespace(id=mint_uuid()))

    kept = await Conversation.get_by_id(mine.id)
    assert kept is not None and kept.remote is False
    assert await Conversation.get_by_id(theirs.id) is None
