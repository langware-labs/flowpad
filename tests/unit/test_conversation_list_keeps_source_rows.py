"""The conversation list prunes a hub mirror the hub stopped listing, but not a row a data source
feeds: a help-desk ticket staff returned is out of their list on the hub and still on their desk."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.cloud_client.hub_proxy import HubProxy, HubWalk


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_source_fed_row_survives_the_hub_list_and_a_plain_mirror_does_not():
    fed = Conversation(id=mint_uuid(), remote=True, title="ticket", channel_source_id=mint_uuid())
    mirror = Conversation(id=mint_uuid(), remote=True, title="left")
    await fed.save()
    await mirror.save()

    with (
        patch.object(HubProxy, "walk", new=AsyncMock(return_value=HubWalk(rows=[], complete=True))),
        patch.object(HubProxy, "try_call", new=AsyncMock(return_value=[])),
        patch.object(fma, "hub_base_url", return_value="https://hub.test"),
        patch("flow_sdk.cli.auth.hub_login.hub_auth_available", return_value=True),
    ):
        await fma.handle_conversation_list(SimpleNamespace(id=mint_uuid()))

    assert await Conversation.get_by_id(fed.id) is not None
    assert await Conversation.get_by_id(mirror.id) is None
