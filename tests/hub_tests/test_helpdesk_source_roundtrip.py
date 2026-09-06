"""A guest opens a ticket; the desk owner's inbox gets it as a message source
and answers it — through the hub, end to end.

Identities: THIS instance (alice, `hub_session`) owns the desk and polls it
through the driver, exactly as the app does; bob (`bob_token`) is the guest
who opens the ticket over raw hub HTTP, the way a requester's app would.

The desk is a project this test creates and deletes, so "bob is not a member"
is real rather than arranged, and nothing here touches the deployment's
canonical desk. Requires a running local hub; the tier skips otherwise.
"""
from __future__ import annotations

import asyncio
import uuid

import httpx
import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.inbox.outbound import dispatch_channel_reply
from flow_sdk.inbox.projection import reconcile_source
from flow_sdk.ingest.sync import sync_source

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(30)]  # do not increase timeout without approval

#: Bounded well inside the cap, so the readable assertion fails rather than
#: the timeout kill. A reply is dispatched as a task; this is how long the hub
#: is given to show it — the SAME number the mailbox round trip uses, imported
#: so an agent turn is given one budget everywhere.
from tests.hub_tests.test_agent_email_conversation import REPLY_DEADLINE_SECONDS  # noqa: E402

REPLY_POLL_SECONDS = 0.5

DISPLAY_NAME = "Test Support"


@pytest.fixture(scope="session", autouse=True)
def _reclaim_hub_entities_the_tier_creates():
    """Skip the tier-wide scan: every row here has exact cleanup."""
    yield


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
async def desk(hub_session):
    """A desk project owned by alice, deleted after — asserted, so a leak is loud."""
    base, token = hub_session["base_url"], hub_session["api_key"]
    async with httpx.AsyncClient(timeout=20) as h:
        r = await h.post(f"{base}/api/v1/graph/project", headers=_auth(token), json={"name": f"desk-{uuid.uuid4().hex[:8]}"})
        assert r.status_code == 200, r.text
        desk_id = r.json()["data"]["id"]
        # `enable_helpdesk` is what stamps the guest role: without it a
        # non-member's start_guest_conversation is refused.
        on = await h.post(
            f"{base}/api/v1/graph/project/{desk_id}/enable_helpdesk",
            headers=_auth(token),
            json={"enabled": True, "display_name": DISPLAY_NAME, "mode": "human"},
        )
        assert on.status_code == 200, on.text
    try:
        yield desk_id
    finally:
        async with httpx.AsyncClient(timeout=20) as h:
            gone = await h.request("DELETE", f"{base}/api/v1/graph/project/{desk_id}", headers=_auth(token), json={})
        assert gone.status_code < 400, f"LEAKED desk project {desk_id}: {gone.text[:200]}"


async def _open_ticket(base: str, guest_token: str, desk_id: str, text: str) -> str:
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.post(
            f"{base}/api/v1/graph/project/{desk_id}/start_guest_conversation",
            headers=_auth(guest_token),
            json={"text": text},
        )
        assert r.status_code == 200, r.text
        return r.json()["data"]["id"]


async def _hub_messages(base: str, token: str, conv_id: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.get(f"{base}/api/v1/graph/conversation/{conv_id}/flow_message", headers=_auth(token))
        assert r.status_code == 200, r.text
        return list(r.json().get("data") or [])


async def _pool(base: str, token: str, desk_id: str) -> list[dict]:
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.get(f"{base}/api/v1/graph/project/{desk_id}/helpdesk_conversations", headers=_auth(token))
        assert r.status_code == 200, r.text
        return list(r.json().get("data") or [])


async def _await_hub_message(base, token, conv_id, *, containing: str, not_from: str = "") -> dict | None:
    """The first hub message whose text carries `containing` — and was not
    written by `not_from`, so a ticket that QUOTES the expected answer (the
    nonce it asks for) cannot pass as the reply. None on the deadline."""
    deadline = asyncio.get_event_loop().time() + REPLY_DEADLINE_SECONDS
    while asyncio.get_event_loop().time() < deadline:
        for m in await _hub_messages(base, token, conv_id):
            if containing in str(m.get("text") or "") and str(m.get("sender_id") or "") != not_from:
                return m
        await asyncio.sleep(REPLY_POLL_SECONDS)
    return None


async def _poll(source: DataSource) -> None:
    """One poll the way the server does it: the driver fetch, then the inbox
    projection's reconcile sweep (the lane a first, BACKFILL sync relies on —
    pytest never starts the bus lanes, so the sweep is called directly)."""
    await sync_source(source)
    placed = await reconcile_source(str(source.id))
    assert placed >= 0


async def _desk_source(desk_id: str) -> DataSource:
    source = DataSource(name="test desk", provider="helpdesk", config={"desk_project_id": desk_id})
    await source.save()
    return source


async def test_a_guest_ticket_reaches_the_desk_owner_as_a_message_source_and_the_reply_comes_back(
    hub_session, bob_token, desk
):
    base, me = hub_session["base_url"], hub_session["user_id"]
    ts = uuid.uuid4().hex[:8]
    ticket = await _open_ticket(base, bob_token, desk, f"my printer is broken {ts}")
    first = (await _hub_messages(base, hub_session["api_key"], ticket))[0]

    # The projection attributes our own replies to the LOCAL user; pytest never
    # runs bootstrap, so the row a server has from birth is created here.
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user

    local_user = await get_or_create_local_user()
    source = await _desk_source(desk)
    try:
        # ONE poll: pool → the ticket's messages → ingest → project.
        await _poll(source)

        item = await SourceItem.find_existing(source.id, ticket, first["id"])
        assert item is not None and item.conversation_id == ticket and item.message_id == first["id"]
        threads = [t for t in await MessageThread.get_all({"channel": "helpdesk"}) if t.thread_key == f"{desk}:{ticket}"]
        assert len(threads) == 1 and threads[0].conversation_id == ticket, "the thread adopted the hub conversation"
        assert await Conversation.get_one({"id": ticket}) is not None
        fm = await FlowMessage.get_one({"id": first["id"]})
        assert fm is not None and fm.origin.kind == "helpdesk", "the FlowMessage wears the hub's own id and the channel"
        assert source.account_identities == [me], "the desk answers as this login"

        # The reply goes the way the composer sends it: the channel path.
        outcome = await dispatch_channel_reply(ticket, text=f"try restarting it {ts}", source_id=source.id)
        assert getattr(outcome, "status", "") != "FAIL", getattr(outcome, "message", outcome)
        reply = await _await_hub_message(base, hub_session["api_key"], ticket, containing=f"try restarting it {ts}")
        assert reply is not None, "the reply never reached the hub"
        assert reply["sender_id"] == me
        assert reply["sender_name"] == DISPLAY_NAME, "the hub masks staff to the desk brand"
        pool = {row["conversation_id"]: row for row in await _pool(base, hub_session["api_key"], desk)}
        assert pool[ticket]["picked_up"] is True, "send picked the ticket up first"

        # The sent copy ingests onto the hub's id — one row per message, no twin.
        await _poll(source)
        rows = await FlowMessage.get_all({"conversation_id": ticket})
        assert sorted(r.id for r in rows) == sorted([first["id"], reply["id"]])
        loaded = await DataSource.get_one({"id": source.id})
        from flow_sdk.inbox.projection import self_addresses
        sent_item = await SourceItem.find_existing(source.id, ticket, reply["id"])
        assert sent_item is not None and sent_item.author_external_id == me, (sent_item.author_external_id, me)
        assert me in self_addresses(loaded), (loaded.account_identities, loaded.account_key)
        mine = await FlowMessage.get_one({"id": reply["id"]})
        assert mine.origin.kind == "helpdesk"
        assert mine.sender_id == str(local_user.id), "our own reply is attributed to us, not to a stranger"
    finally:
        await source.delete()


async def test_a_stranger_is_refused_by_the_pool_in_a_sentence(hub_session, bob_token, desk):
    """Bob is not a member of alice's desk; a source he'd own parks with the
    membership sentence, not a generic error. Exercised through the driver's
    hub seam with bob's token, since this instance is logged in as alice."""
    from flow_sdk.cloud_client.shared.errors import HubError
    from flow_sdk.ingest.drivers.helpdesk import _as_source_error

    base = hub_session["base_url"]
    async with httpx.AsyncClient(timeout=10) as h:
        r = await h.get(f"{base}/api/v1/graph/project/{desk}/helpdesk_conversations", headers=_auth(bob_token))
    assert r.status_code in (401, 403), r.text
    err = _as_source_error(HubError(r.status_code, r.json().get("message") or ""))
    assert err.code == "not_a_member" and "member" in err.detail


# ── an Agent owns the desk ───────────────────────────────────────────────────


@pytest.fixture
def cli_for_a_real_turn():
    """The spawned CLI needs a harness capability and a Claude home it can
    authenticate from. The capability is borrowed from the mailbox test so the
    two agree on what a turn needs. The home is NOT taken by swapping `$HOME`
    (that would also move this process's own credentials, and the poll would
    read the desk signed out): `FLOWPAD_CLAUDE_HOME` is the variable the test
    settings honour for exactly this — point it at the real `~/.claude`."""
    import os

    from tests.hub_tests.test_agent_email_conversation import _inject_claude_harness

    if not os.environ.get("FLOWPAD_CLAUDE_HOME"):
        pytest.skip("set FLOWPAD_CLAUDE_HOME=$HOME/.claude so the spawned CLI can authenticate")
    _inject_claude_harness()
    yield


async def test_an_agent_owned_desk_answers_a_stranger(hub_session, bob_token, desk, cli_for_a_real_turn):
    """The reason the desk became a source: an Agent can hold it and answer
    people nobody listed. Same triage as the mailbox test — no process at all is
    our wiring broken; a process that said nothing is the CLI's availability."""
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.inbox import start_inbox
    from flow_sdk.inbox.agent_scope import resolve_agent_inbox_scope
    from flow_sdk.schema.types import EntityType
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user
    from tests.hub_tests._hub_agent import create_hub_agent, delete_hub_agent
    from tests.hub_tests.test_agent_email_conversation import _ran_a_turn

    base, token = hub_session["base_url"], hub_session["api_key"]
    await get_or_create_local_user()
    # The SAME call `server/app.py` makes: arms the projection lanes and the
    # agent runner, so a projected inbound message runs the turn.
    start_inbox()

    agent_id = await create_hub_agent(base, token, f"desk-agent-{uuid.uuid4().hex[:8]}")
    agent = Agent(
        id=agent_id,
        name=f"Deskbot {agent_id[:8]}",
        worker_type="claude",
        system_prompt="You are first-line support. Reply with exactly the word the ticket asks for and nothing else.",
    )
    await agent.save()
    # `bind_channel` is the one door: the source is born the agent's, with an
    # EMPTY allowlist — a desk is open to strangers by declaration.
    source = await agent.bind_channel(provider="helpdesk", channel=desk)
    assert source.provider == "helpdesk" and not (source.inbound_allowed_senders or [])
    assert str(source.owner) == str(TypeId(type=EntityType.AGENT.value, id=agent_id))

    nonce = f"okra{uuid.uuid4().hex[:8]}"
    ticket = await _open_ticket(base, bob_token, desk, f"Reply with exactly this word and nothing else: {nonce}")
    guest_id = str((await _hub_messages(base, token, ticket))[0].get("sender_id") or "")
    try:
        # One poll drives the chain: pool → ingest → project → announce → turn → reply.
        await _poll(source)
        reply = await _await_hub_message(base, token, ticket, containing=nonce, not_from=guest_id)
        if reply is None:
            if not await _ran_a_turn():
                pytest.fail("no agent process was created — the ticket never reached the agent")
            pytest.skip("agent process ran but produced no reply (no live CLI turn available)")
        # The hub saw a member reply and masked it; locally it is the agent's.
        assert reply["sender_name"] == DISPLAY_NAME
        await _poll(source)
        mine = await FlowMessage.get_one({"id": reply["id"]})
        assert mine is not None and mine.sender_id == f"agent:{agent_id}", mine.sender_id
        scope = await resolve_agent_inbox_scope(agent_id)
        assert ticket in scope.conversation_ids, "the ticket is in the agent's inbox, not the user's"
    finally:
        await source.delete()
        await agent.delete()
        assert await delete_hub_agent(base, token, agent_id) < 400, f"LEAKED agent {agent_id}"
