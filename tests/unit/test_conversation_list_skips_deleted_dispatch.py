"""A hub-deleted conversation must not be dispatched for a background message
fetch — but it currently is.

Root cause: ``handle_conversation_list`` (flow_sdk/app/actions/flow_message_action.py)
computes ``should_fetch = _should_fetch_messages(existing, hub_conv)`` BEFORE
checking whether the hub reports the conversation deleted. For a conversation
the user already deleted locally (``existing is None``), ``_should_fetch_messages``
unconditionally returns True ("no local row -> fetch"). The metadata-upsert step
that follows DOES correctly read ``hub_conv["deleted_at"]`` and no-ops instead of
recreating the row — but ``should_fetch`` was already decided two lines earlier
and is appended to ``bg_fetch_dispatched`` regardless, so the background job goes
and re-downloads the full message history for an already-deleted conversation,
materializing it back into the local database.

Confirmed live on production (app.flowpad.ai): a real, previously-deleted
conversation ("test3", deleted 2026-07-09) was found fully resurrected locally
with all its messages, re-triggered on every single inbox open.

This test drives the REAL ``handle_conversation_list`` handler — only the hub
HTTP boundary (``hub_get``) is mocked, matching the established pattern in
``test_conversation_list_logged_out_gate.py`` (hub_get is an external network
call, not the code under test).
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_deleted_conversation_is_not_dispatched_for_message_fetch(monkeypatch):
    from flow_sdk.app.actions import flow_message_action as fma
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

    deleted_conv_id = str(uuid.uuid4())

    monkeypatch.setattr(fma, "hub_base_url", lambda: "http://hub.invalid")
    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.hub_auth_available", lambda: True)

    hub_conv = {
        "id": deleted_conv_id,
        "title": "test3",
        "message_count": 1,
        "updated_date": datetime.now(timezone.utc).isoformat(),
        "created_date": "2026-07-01T00:00:00+00:00",
        # The hub-authoritative deletion signal — audit-only soft delete, same
        # shape confirmed on the live hub for the real resurrected conversation.
        "deleted_at": "2026-07-09T19:12:05.118504+00:00",
        "participants": [],
    }

    async def _fake_hub_get(entity_type, *args, **kwargs):
        if entity_type == BuiltinEntityType.CONVERSATION and not args and "action" not in kwargs:
            return [hub_conv]
        if entity_type == BuiltinEntityType.INVITATION:
            return []
        raise AssertionError(f"unexpected hub_get call: {entity_type=} {args=} {kwargs=}")

    monkeypatch.setattr(fma, "hub_get", _fake_hub_get)

    resp = await fma.handle_conversation_list(SimpleNamespace(id="local-someone-typeid"))

    # BUG (unfixed): the deleted conversation's id ends up in bg_fetch_dispatched
    # anyway, so a background task re-downloads and resurrects its messages.
    assert deleted_conv_id not in resp.data["bg_fetch_dispatched"], (
        "a hub-deleted conversation was dispatched for a background message "
        "fetch — this is what resurrects deleted conversations locally"
    )
