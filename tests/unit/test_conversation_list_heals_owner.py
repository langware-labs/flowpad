"""A conversation synced before ``initiated_by`` was its own field gets the hub's owner on the next list.

Such a row holds no ``initiated_by`` and the hub clock never moves for it, so the clock gate alone
would skip it forever — and its owner would read "Leave" instead of "Delete for everyone". The list
re-mirrors it once; a healed row then matches and is skipped again. Only the hub HTTP boundary
(``HubProxy.walk`` / ``HubProxy.try_call``) is replaced, as in ``test_conversation_list_skips_deleted_dispatch.py``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.cloud_client.hub_proxy import HubProxy, HubWalk


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_row_without_its_owner_takes_it_once(monkeypatch):
    from flow_sdk.app.actions import flow_message_action as fma
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

    conv_id = str(uuid.uuid4())
    me = f"user-{uuid.uuid4()}"
    hub_updated = datetime(2026, 10, 1, tzinfo=timezone.utc)
    hub_conv = {
        "id": conv_id,
        "title": "Synced before the rename",
        "initiated_by": "owner-cloud-id",
        "message_count": 0,
        "updated_date": hub_updated.isoformat(),
        "members": [{"user_id": "owner-cloud-id", "name": "Owner", "role": "owner"}],
    }
    # The row as an older desktop left it: remote, reconciled through this hub revision, no owner.
    old = await Conversation.mirror_from_hub({k: v for k, v in hub_conv.items() if k != "initiated_by"})
    old.hub_updated_date = hub_updated
    await old.save(None)
    assert (await Conversation.get_one({"id": conv_id})).initiated_by is None

    monkeypatch.setattr(fma, "hub_base_url", lambda: "http://hub.invalid")
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.hub_auth_available", lambda: True)

    async def _fake_hub(_method, entity_type, *args, **kwargs):
        if entity_type == BuiltinEntityType.INVITATION:
            return []
        raise AssertionError(f"unexpected HubProxy.try_call: {entity_type=} {args=} {kwargs=}")

    monkeypatch.setattr(HubProxy, "try_call", staticmethod(_fake_hub))

    async def _fake_walk(entity_type, **_kw):
        assert entity_type == BuiltinEntityType.CONVERSATION
        return HubWalk(rows=[hub_conv], complete=True, pages=1)

    monkeypatch.setattr(HubProxy, "walk", staticmethod(_fake_walk))
    upserts: list[str] = []
    real_upsert = fma._upsert_hub_conversation_metadata

    async def _counting_upsert(row, *a, **kw):
        upserts.append(row["id"])
        return await real_upsert(row, *a, **kw)

    monkeypatch.setattr(fma, "_upsert_hub_conversation_metadata", _counting_upsert)

    await fma.handle_conversation_list(me)
    assert (await Conversation.get_one({"id": conv_id})).initiated_by == "owner-cloud-id"
    assert upserts.count(conv_id) == 1

    await fma.handle_conversation_list(me)
    assert upserts.count(conv_id) == 1, "a healed row must not be re-written on every list"
