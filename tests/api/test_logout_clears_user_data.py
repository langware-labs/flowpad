"""Logout clears the hub-derived local data, not just the credentials.

Three things are pinned here:

* the hub's copy goes — a ``remote=True`` conversation, its messages (including
  a ``PENDING_SEND`` draft queued while offline), its thread, and the org row
  login materialized;
* a locally-projected conversation SURVIVES — see ``flow_sdk/inbox/clear.py``
  for why deleting one would be unrecoverable;
* an involuntary invalidation (expired / rejected token) purges NOTHING.

The hub fetch is mocked throughout — these tests never leave the process.
"""
from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import DeliveryStatus, FlowMessage
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.organization import Organization

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _search(client, needle: str) -> list[str]:
    """Conversation ids whose message bodies match — the read-back the UI does."""
    response = await client.post("/api/v1/graph/inbox-search", json={"q": needle})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "SUCCESS", body
    return body["data"]["conversation_ids"]


async def _seed(marker: str) -> tuple[str, str, str]:
    """One hub conversation, one local one, and a remote org. Returns their ids.

    The hub conversation carries three children a purge has to reach: a normal
    message, a thread, and a ``PENDING_SEND`` draft whose own ``remote`` flag is
    False — the offline outbox. Scoping the delete to the message's own flag
    would strand that draft, which is why the purge keys off the CONVERSATION.
    """
    hub_conv_id, local_conv_id = str(uuid.uuid4()), str(uuid.uuid4())

    await Conversation(id=hub_conv_id, title=f"hub {marker}", remote=True).save(notify=False)
    await FlowMessage(
        id=str(uuid.uuid4()),
        conversation_id=hub_conv_id,
        text=f"{marker}-from-hub",
        remote=True,
    ).save(notify=False)
    await FlowMessage(
        id=str(uuid.uuid4()),
        conversation_id=hub_conv_id,
        text=f"{marker}-queued-offline",
        delivery_status=DeliveryStatus.PENDING_SEND,
    ).save(notify=False)
    await MessageThread(
        id=str(uuid.uuid4()),
        channel="gmail",
        thread_key=f"{marker}-hub-thread",
        conversation_id=hub_conv_id,
        title=f"hub {marker}",
    ).save(notify=False)

    # The control: a locally-projected conversation. Nothing here is the hub's.
    await Conversation(id=local_conv_id, title=f"local {marker}", remote=False).save(notify=False)
    await FlowMessage(
        id=str(uuid.uuid4()),
        conversation_id=local_conv_id,
        text=f"{marker}-from-gmail",
    ).save(notify=False)

    org_id = str(uuid.uuid4())
    await Organization(id=org_id, name=f"Acme {marker}", remote=True).save(notify=False)

    return hub_conv_id, local_conv_id, org_id


@pytest.mark.asyncio
async def test_logout_clears_hub_conversations_and_keeps_local_ones(bootstrapped_client):
    marker = uuid.uuid4().hex[:12]
    hub_conv_id, local_conv_id, org_id = await _seed(marker)

    # Both are present before the logout, or the test proves nothing.
    assert set(await _search(bootstrapped_client, marker)) == {hub_conv_id, local_conv_id}

    with patch("flow_sdk.app.actions.flow_message_action.hub_get", return_value=[]):
        response = await bootstrapped_client.post("/api/v1/cloud/logout")
    assert response.status_code == 200, response.text

    assert await _search(bootstrapped_client, marker) == [local_conv_id]

    assert await Conversation.get_one({"id": hub_conv_id}) is None
    assert await Conversation.get_one({"id": local_conv_id}) is not None
    assert await FlowMessage.get_all({"conversation_id": hub_conv_id}) == []
    assert await FlowMessage.get_all({"conversation_id": local_conv_id}) != []
    assert await MessageThread.get_all({"conversation_id": hub_conv_id}) == []
    assert await Organization.get_one({"id": org_id}) is None


@pytest.mark.asyncio
async def test_logout_is_idempotent(bootstrapped_client):
    """Two doors open onto this intent — POST /logout and the Connections
    disconnect action — so a repeat must be a quiet no-op, not a second purge.
    (/logout_callback, the other leg of a desktop logout, clears credentials
    only and never reaches the purge.)"""
    marker = uuid.uuid4().hex[:12]
    _, local_conv_id, _ = await _seed(marker)

    with patch("flow_sdk.app.actions.flow_message_action.hub_get", return_value=[]):
        first = await bootstrapped_client.post("/api/v1/cloud/logout")
        second = await bootstrapped_client.post("/api/v1/cloud/logout")

    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert await _search(bootstrapped_client, marker) == [local_conv_id]


@pytest.mark.asyncio
async def test_involuntary_invalidation_keeps_local_data(bootstrapped_client):
    """An expired/rejected token clears credentials and NOTHING else."""
    from flow_sdk.cloud_client.auth_state import invalidate_hub_login

    marker = uuid.uuid4().hex[:12]
    hub_conv_id, local_conv_id, org_id = await _seed(marker)

    await invalidate_hub_login("expired")

    assert set(await _search(bootstrapped_client, marker)) == {hub_conv_id, local_conv_id}
    assert await Organization.get_one({"id": org_id}) is not None
