from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.cloud_client.hub_proxy import HubProxy, HubWalk


@pytest.mark.asyncio
async def test_deleted_hub_audit_row_is_removed_without_background_fetch():
    conv_id = "aaaa0011-1111-4111-8111-000000000011"
    local = Conversation.model_validate(
        {
            "id": conv_id,
            "title": "deleted audit",
            "remote": True,
            "message_count": 0,
        },
    )
    hub_row = {
        "id": conv_id,
        "title": "deleted audit",
        "deleted_at": "2026-07-25T12:00:00Z",
        "message_count": 3,
        "updated_date": "2026-07-25T12:00:00Z",
    }
    local_present = True

    async def get_all(_query):
        return [local] if local_present else []

    async def hard_delete(_conversation):
        nonlocal local_present
        local_present = False

    async def fake_try_call(_method, entity_type, **_kwargs):
        return []

    dispatch = MagicMock()
    with (
        patch.object(Conversation, "get_all", new=AsyncMock(side_effect=get_all)),
        patch.object(HubProxy, "walk", new=AsyncMock(return_value=HubWalk(rows=[hub_row], complete=True))),
        patch.object(HubProxy, "try_call", new=AsyncMock(side_effect=fake_try_call)),
        patch.object(fma, "hub_base_url", return_value="https://hub.test"),
        patch(
            "flow_sdk.cli.auth.hub_login.hub_auth_available",
            return_value=True,
        ),
        patch.object(
            fma,
            "_hard_delete_local_conversation",
            new=AsyncMock(side_effect=hard_delete),
        ) as delete_mock,
        patch.object(
            fma,
            "_upsert_hub_conversation_metadata",
            new=AsyncMock(),
        ) as upsert_mock,
        patch.object(fma, "_dispatch_conversation_message_fetches", new=dispatch),
    ):
        response = await fma.handle_conversation_list(
            SimpleNamespace(id="bbbb0011-1111-4111-8111-000000000011"),
        )

    assert response.status == "SUCCESS"
    assert response.data["conversations"] == []
    assert response.data["bg_fetch_dispatched"] == []
    delete_mock.assert_awaited_once_with(local)
    upsert_mock.assert_not_awaited()
    # The batch is a mapping of conv id -> the hub revision that justified the
    # fetch; the drain stamps it as the watermark only on a successful reconcile.
    dispatch.assert_called_once_with(
        {},
        SimpleNamespace(id="bbbb0011-1111-4111-8111-000000000011"),
    )
