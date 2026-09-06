"""A message queued while logged out must reach the hub once you log back in.

Observed in production on 2026-09-06: a reply typed into an already-shared
conversation while the desktop was signed out of Flowpad Cloud was stored
``delivery_status=pending_send``. Signing back in did not send it. A LATER
message in the SAME conversation went out fine (``delivered``), so the account,
the hub and the conversation were all healthy — only the queued one was
stranded, silently, with the UI showing it in the thread as though it had been
sent.

Why: ``_deliver_pending_messages`` is the only flush there is, and its ONLY
caller is ``Conversation.share()`` (flow_sdk/builtin/conversation.py:420), in
the branch that creates the hub row. A conversation that is ALREADY remote --
the recipient shared it, or you shared it before going offline -- never takes
that branch again, so nothing re-attempts the message. Login does not flush it
either: no login path references pending messages at all. ``handle_add_message``
documents the queue as flushed "when the conversation next becomes remote",
which for an already-remote conversation is never.

Nothing here is mocked. The instance really logs out (``clear_cloud_credentials``),
the message is really queued by the handler the gate calls, login really runs
through ``_finalize_login`` -- the chokepoint both login modes converge on -- and
the assertion is the HUB's own row list, not a local projection: "did it send" is
a hub-side fact.

The gate one frame above (``add_message`` in share_action.py) is the code that
decides ``pending_send``; it needs a request ExecutionContext, so the test
asserts its condition (``not is_logged_in()``) holds and calls the handler with
the argument the gate passes under exactly that condition -- the same seam the
sibling hub test for ``handle_add_message`` uses.
"""

from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest


async def _hub_texts(hub_base_url: str, api_key: str, conv_id: str) -> list[str]:
    """Every message text the HUB holds for this conversation."""
    async with httpx.AsyncClient(timeout=15.0) as h:
        r = await h.get(
            f"{hub_base_url}/api/v1/graph/conversation/{conv_id}/flow_message",
            headers={"Authorization": f"Bearer {api_key}"},
        )
    r.raise_for_status()
    return [(m.get("text") or "").strip() for m in (r.json().get("data") or [])]


async def _drain_catchup_tasks() -> None:
    """Await the fire-and-forget work login schedules, rather than sleeping.

    Login must not block on a hub round-trip, so its catch-up runs as a named
    task. Awaiting the task is deterministic and leaves no polling budget to
    tune; if a fix flushes the outbox from here, this is where it lands.
    """
    for task in [t for t in asyncio.all_tasks() if (t.get_name() or "").startswith("inbox-catchup:")]:
        await task


@pytest.fixture(autouse=True)
async def _stop_hub_ws_after():
    """``_finalize_login`` restarts the process-global hub WS; put it back.

    The manager is a module singleton, so a live connection would leak into
    every later test in the session (the ``/api/v1/cloud/status`` tests assert
    ``hub_ws_connected is False``).
    """
    yield
    from flow_sdk.cloud_client.ws_client import hub_ws_manager

    await hub_ws_manager.stop()


# do not increase timeout without approval
@pytest.mark.asyncio
@pytest.mark.timeout(60)
async def test_message_queued_while_logged_out_reaches_the_hub_after_login(
    hub_base_url, hub_login_payload, isolated_hub_keyring
):
    """Queue a message offline in a shared conversation, log in, and it sends."""
    from flow_sdk.app.actions.notification_action import handle_add_message
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import DeliveryStatus, FlowMessage
    from flow_sdk.cli.auth.cloud_login import _finalize_login, clear_cloud_credentials
    from flow_sdk.cli.auth.hub_login import hub_auth_available, is_logged_in
    from flow_sdk.cloud_client.api.auth import LoginData
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user
    from tests.hub_tests._local_login import login_as

    api_key = login_as(hub_login_payload)
    someone = (await get_or_create_local_user()).typeid

    # 1. A conversation that is ALREADY on the hub — the shape the bug needs.
    #    Sharing it now is what makes a later re-share a no-op, so nothing will
    #    ever call the flush again.
    conv = Conversation(title=f"pending-flush-{uuid.uuid4().hex[:8]}")
    await conv.share(recipients=[])
    assert conv.remote is True, "precondition: the conversation must be hub-backed"
    await conv.save(someone)

    # 2. Really sign out. This is the state the app is in when the user's cloud
    #    session has lapsed and they keep typing.
    await clear_cloud_credentials()
    assert not is_logged_in(), "precondition: the instance must be signed out"

    # 3. Send while signed out. `pending_send=True` is what the add_message gate
    #    (share_action.py) passes under the condition asserted just above.
    queued_text = f"queued-offline-{uuid.uuid4().hex[:8]}"
    await handle_add_message(
        {"conversation_id": conv.id, "text": queued_text}, someone, pending_send=True
    )

    queued = await FlowMessage.get_one({"conversation_id": conv.id, "text": queued_text})
    assert queued is not None, "precondition: the offline send must be stored locally"
    assert queued.delivery_status == DeliveryStatus.PENDING_SEND.value, (
        f"precondition: the offline send should be queued, got {queued.delivery_status!r}"
    )

    # 4. Log back in for real, through the funnel both login modes converge on.
    await _finalize_login(LoginData.model_validate(hub_login_payload))
    assert hub_auth_available(), "login should have established a cloud session"
    await _drain_catchup_tasks()

    # 5. Control, and the exact shape of the production report: a message sent
    #    normally AFTER logging back in goes out fine. Without this the hub
    #    could be empty because the session, the conversation or the read is
    #    broken — which would prove nothing about the queued one.
    live_text = f"sent-after-login-{uuid.uuid4().hex[:8]}"
    await handle_add_message({"conversation_id": conv.id, "text": live_text}, someone)

    texts = await _hub_texts(hub_base_url, api_key, conv.id)
    assert live_text in texts, (
        f"control failed: a normal send after login did not reach the hub either, so this "
        f"test says nothing about the queued message. Hub holds {texts!r}."
    )

    # 6. The symptom: the later message is on the hub and the queued one is not.
    #    The user sees the queued one sitting in the thread as though it were
    #    sent, the recipient never receives it, and nothing reports an error.
    assert queued_text in texts, (
        f"a message queued while signed out never reached the hub after login, though a "
        f"message sent moments later did; hub holds {texts!r}. Nothing retries it: "
        f"_deliver_pending_messages is only called from Conversation.share() when the hub "
        f"row is first created, and an already-shared conversation never takes that branch."
    )
