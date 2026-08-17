"""Logging in must pull the hub backlog into the Inbox — against a live hub.

The reported bug: alice sends bob a message while bob's app is logged out.
Bob logs in and sees nothing; the conversation only appears after he clicks
the Inbox's "Fetch new messages from hub" button.

Why it happens: the hub's fan-out is live-only (``_fanout_message`` pushes to
a participant's currently-open WS connections and drops the frame otherwise —
no offline queue, no replay on reconnect), so the desktop is responsible for
pulling the backlog on every "no hub session → hub session" transition. It
only did that at backend startup, gated on ``hub_auth_available()``. Boot
logged out and the sweep bails; log in afterwards and nothing re-runs it.

The test drives the production login chokepoint ``_finalize_login`` — the
single point both login modes converge on (env-mode ``_login_by_api`` and
browser-mode ``/auth/login_callback``) — with a REAL hub login payload against
the REAL local hub. Nothing is mocked: the conversation is really created on
the hub, the local instance is really logged out, and login really runs.
"""

from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]


@pytest.fixture(autouse=True)
async def _stop_hub_ws_after():
    """Leave the process-global hub WS as we found it.

    ``_finalize_login`` restarts ``hub_ws_manager`` — that IS the production
    behaviour we're exercising, but the manager is a module singleton, so a
    live connection would leak into every later test in the session (the
    ``/api/v1/cloud/status`` tests assert ``hub_ws_connected is False``).
    """
    yield
    from flow_sdk.cloud_client.ws_client import hub_ws_manager

    await hub_ws_manager.stop()


async def _hub_create_conversation_with_message(
    hub_base_url: str,
    api_key: str,
    *,
    title: str,
    text: str,
) -> str:
    """Create a Conversation on the hub with one message in it, exactly as a
    sender would. Returns the conversation id."""
    from flow_sdk.builtin.conversation import Conversation

    conv = Conversation(title=title)
    await conv.share()
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=5.0) as h:
        await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/join",
            headers=headers,
            json={},
        )
        r = await h.post(
            f"{hub_base_url}/api/v1/graph/conversation/{conv.id}/add_message",
            headers=headers,
            json={"text": text},
        )
    assert r.status_code == 200, r.text
    return conv.id  # type: ignore[return-value]


async def _drain_catchup_tasks() -> bool:
    """Await every login catch-up task the login funnel spawned.

    ``start_hub_catchup`` is fire-and-forget by design (login must not block on
    a hub round-trip), so the test awaits the task itself rather than sleeping
    — deterministic, and no polling budget to tune. Returns whether any
    catch-up was scheduled at all; on the unfixed code there is none, and the
    assertion below is what reports the bug.
    """
    tasks = [t for t in asyncio.all_tasks() if (t.get_name() or "").startswith("inbox-catchup:")]
    for t in tasks:
        await t
    return bool(tasks)


async def test_login_pulls_hub_backlog_into_local_store(hub_base_url, hub_login_payload):
    """A conversation that landed on the hub while logged out is present
    locally once login completes — with no Inbox refresh in between."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.cli.auth.cloud_login import _finalize_login, clear_cloud_credentials
    from flow_sdk.cli.auth.hub_login import hub_auth_available
    from flow_sdk.cloud_client.api.auth import LoginData
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user
    from tests.hub_tests._local_login import login_as

    # 0. Production precondition: the @local desktop user exists — bootstrap
    #    mints it long before any login. Each test gets a unique EMPTY
    #    FLOW_INSTANCE, so without this the catch-up bails on its
    #    ``uname='local'`` lookup for a reason the real app never hits, and the
    #    test would go red on a fixture artifact instead of the bug.
    await get_or_create_local_user()

    # 1. Sender side: put a real conversation + message on the hub.
    api_key = login_as(hub_login_payload)
    conv_id = await _hub_create_conversation_with_message(
        hub_base_url,
        api_key,
        title=f"backlog-{uuid.uuid4()}",
        text="sent while the recipient was logged out",
    )

    # 2. Recipient side: really log out. This is the state the app boots into
    #    when the user last quit signed out — the one that makes the startup
    #    sweep bail.
    await clear_cloud_credentials()
    assert not hub_auth_available(), "precondition: the instance must be logged out"

    # 3. Precondition — the hub conversation is NOT local yet. Without this the
    #    test could pass on a row that some earlier step wrote locally, proving
    #    nothing.
    assert await Conversation.get_one({"id": conv_id}) is None, (
        "precondition: the hub conversation must not already be in the local store"
    )

    # 4. Log in for real, through the funnel both login modes converge on.
    await _finalize_login(LoginData.model_validate(hub_login_payload))
    assert hub_auth_available(), "login should have established a cloud session"
    scheduled = await _drain_catchup_tasks()

    # 5. The symptom: bob is logged in, and the conversation alice sent him is
    #    still missing locally — so the Inbox renders nothing until he finds
    #    the manual refresh button.
    local = await Conversation.get_one({"id": conv_id})
    assert local is not None, (
        "conversation sent while logged out is still missing after login "
        f"(catch-up scheduled: {scheduled}) — the Inbox stays empty until the "
        "user clicks 'Fetch new messages from hub'"
    )
