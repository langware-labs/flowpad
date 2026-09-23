"""Several message sources, one loop, every message attributed to the source it came from —
through the hub, alice/bob style.

Identities: THIS instance (alice, ``hub_session``) owns the sources. Bob (``bob_token``) opens
tickets over raw hub HTTP, the way a requester's app would. ``blocks.pages(*stream_inboxes)`` delivers
them a page per source; each projected ``FlowMessage`` names its own source; a page's ack moves
only its own position; a reply through each delivery lands back on the hub for bob.

Two shapes of "many sources":

* two help desks — the same channel twice, so attribution has to resolve by SOURCE
  (``origin_local.data_source_id``), the first branch of the stream inbox chip's rule;
* a help desk and an agent mailbox — two channels, resolved by channel as well as source. Needs
  the hub started with ``AGENT_MAILBOX_ENABLED=true AGENT_MAILBOX_PROVIDER=local``; skips otherwise.

Every hub row is created and deleted here.
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

import httpx
import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.blocks import StreamInbox, pages, workflow
from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.agent_mailbox_driver import get_agent_mailbox_driver
from flow_sdk.builtin.consumer_position import ConsumerPosition
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.flow_message import FlowMessage
from tests.hub_tests._hub_agent import create_hub_agent, delete_hub_agent, mailbox_capability_required
from tests.hub_tests._local_login import login_as
from tests.hub_tests.test_agent_email_conversation import _await_reply
from tests.hub_tests.test_helpdesk_source_roundtrip import (
    DISPLAY_NAME,
    _auth,
    _await_hub_message,
    _hub_messages,
    _open_ticket,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.hub, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture(scope="session", autouse=True)
def _reclaim_hub_entities_the_tier_creates():
    """Skip the tier-wide scan: every row here has exact cleanup."""
    yield


async def _take(agen, n: int) -> list:
    out = []
    try:
        for _ in range(n):
            out.append(await agen.__anext__())
    finally:
        await agen.aclose()
    return out


@asynccontextmanager
async def _desk(hub_session, label: str):
    """A desk project owned by alice, deleted after — asserted, so a leak is loud."""
    base, token = hub_session["base_url"], hub_session["api_key"]
    async with httpx.AsyncClient(timeout=20) as h:
        r = await h.post(f"{base}/api/v1/graph/project", headers=_auth(token), json={"name": f"desk-{label}-{uuid.uuid4().hex[:6]}"})
        assert r.status_code == 200, r.text
        desk_id = r.json()["data"]["id"]
        on = await h.post(
            f"{base}/api/v1/graph/project/{desk_id}/enable_helpdesk", headers=_auth(token),
            json={"enabled": True, "display_name": f"{DISPLAY_NAME} {label}", "mode": "human"},
        )
        assert on.status_code == 200, on.text
    try:
        yield desk_id
    finally:
        async with httpx.AsyncClient(timeout=20) as h:
            gone = await h.request("DELETE", f"{base}/api/v1/graph/project/{desk_id}", headers=_auth(token), json={})
        assert gone.status_code < 400, f"LEAKED desk project {desk_id}: {gone.text[:200]}"


async def _projected(delivered) -> FlowMessage:
    fm = await FlowMessage.get_one({"id": delivered.message_id}) if delivered.message_id else None
    fm = fm or await FlowMessage.get_one({"source_item_id": str(delivered._row.id)})
    assert fm is not None, "the delivery was not projected"
    return fm


async def _assert_attributed(delivered, source: DataSource, alice: str) -> None:
    """The projected message names its own channel AND its own source — the rule the stream
    inbox chip resolves by (``origin_local.data_source_id`` first, else ``origin.kind`` == channel)."""
    fm = await _projected(delivered)
    assert fm.origin.kind == source.channel, (fm.origin.kind, source.channel)
    assert fm.origin_local is not None and fm.origin_local.data_source_id == str(source.id)
    assert str(fm.sender_id) != str(alice), "an inbound message is never attributed to us"


async def test_two_desks_one_loop_attribution_resolves_by_source(hub_session, bob_token):
    base, alice = hub_session["base_url"], hub_session["user_id"]
    ts = uuid.uuid4().hex[:8]
    async with _desk(hub_session, "a") as desk_a, _desk(hub_session, "b") as desk_b:
        ticket_a = await _open_ticket(base, bob_token, desk_a, f"printer is broken {ts}")
        ticket_b = await _open_ticket(base, bob_token, desk_b, f"invoice question {ts}")
        bob = str((await _hub_messages(base, hub_session["api_key"], ticket_a))[0]["sender_id"])

        box_a, box_b = StreamInbox(desk_a, provider="helpdesk"), StreamInbox(desk_b, provider="helpdesk")
        name = f"two-desks-{mint_uuid()}"
        sources: list[DataSource] = []
        try:
            async with workflow(name):
                got = await _take(pages(box_a, box_b, size=50, poll_every=0), 2)
                source_a, source_b = await box_a.ensure_source(), await box_b.ensure_source()
                sources = [source_a, source_b]
                by_source = {page.source_id: page for page in got}
                assert set(by_source) == {str(source_a.id), str(source_b.id)}, "one page per source"

                (msg_a,) = [m for m in by_source[str(source_a.id)] if f"printer is broken {ts}" in (m.body or "")]
                (msg_b,) = [m for m in by_source[str(source_b.id)] if f"invoice question {ts}" in (m.body or "")]
                assert (msg_a.thread_key, msg_b.thread_key) == (ticket_a, ticket_b)
                assert msg_a.author_external_id == msg_b.author_external_id == bob, "both tickets are bob's"
                assert source_a.channel == source_b.channel == "helpdesk", "the same channel twice: only the source tells them apart"
                await _assert_attributed(msg_a, source_a, alice)
                await _assert_attributed(msg_b, source_b, alice)

                await by_source[str(source_a.id)].ack()
                assert (await ConsumerPosition.ensure_for(name, str(source_a.id))).watermark() is not None
                assert (await ConsumerPosition.ensure_for(name, str(source_b.id))).watermark() is None, "the other position did not move"

                await msg_a.reply(await msg_a.reply_spec(body=f"try restarting it {ts}"))
                await msg_b.reply(await msg_b.reply_spec(body=f"invoice attached {ts}"))

            for ticket, text, label in ((ticket_a, f"try restarting it {ts}", "a"), (ticket_b, f"invoice attached {ts}", "b")):
                reply = await _await_hub_message(base, hub_session["api_key"], ticket, containing=text)
                assert reply is not None, f"the reply never reached ticket {label}"
                assert reply["sender_id"] == alice and reply["sender_name"] == f"{DISPLAY_NAME} {label}", "the desk brand of ITS desk"
        finally:
            for source in sources:
                await source.delete()


@pytest.fixture
async def mailbox(hub_base_url, hub_login_payload):
    """The agent's mailbox and an outsider's, both released. Skips when the hub has the
    capability off — that is the hub's configuration, not this feature."""
    token = login_as(hub_login_payload)
    driver = get_agent_mailbox_driver()
    agent_id = await create_hub_agent(hub_base_url, token, f"mail-agent-{uuid.uuid4().hex[:8]}")
    outsider_id = await create_hub_agent(hub_base_url, token, f"mail-outsider-{uuid.uuid4().hex[:8]}")
    allocated: list[str] = []
    try:
        with mailbox_capability_required():
            agent_box = await driver.create_mailbox(agent_id)
        allocated.append(agent_id)
        outsider_box = await driver.create_mailbox(outsider_id)
        allocated.append(outsider_id)
        yield {
            "agent_id": agent_id, "agent_address": str(agent_box.get("address") or ""),
            "outsider_id": outsider_id, "outsider_address": str(outsider_box.get("address") or ""),
        }
    finally:
        for released in allocated:
            try:
                await driver.delete_mailbox(released)
            except Exception:  # noqa: BLE001 — a second DELETE answers 404
                pass
        for released in (agent_id, outsider_id):
            assert await delete_hub_agent(hub_base_url, token, released) < 400, f"LEAKED agent {released}"


async def test_a_desk_and_a_mailbox_one_loop_attribution_resolves_by_channel_and_source(hub_session, bob_token, mailbox):
    base, alice = hub_session["base_url"], hub_session["user_id"]
    ts = uuid.uuid4().hex[:8]
    driver = get_agent_mailbox_driver()
    agent = Agent(id=mailbox["agent_id"], name=f"Mailbot {ts}", worker_type="claude", email_allowed_senders=[mailbox["outsider_address"]])
    await agent.save()
    sources: list[DataSource] = []
    try:
        async with _desk(hub_session, "d") as desk:
            ticket = await _open_ticket(base, bob_token, desk, f"printer is broken {ts}")
            await driver.send(mailbox["outsider_id"], {"to": mailbox["agent_address"], "subject": "Ping", "text": f"invoice question {ts}"})

            desk_box = StreamInbox(desk, provider="helpdesk")
            mail_box = StreamInbox(mailbox["agent_address"], provider="cloud_email", owner=agent)
            name = f"desk-and-mail-{mint_uuid()}"
            async with workflow(name):
                got = await _take(pages(desk_box, mail_box, size=50, poll_every=0), 2)
                desk_source, mail_source = await desk_box.ensure_source(), await mail_box.ensure_source()
                sources = [desk_source, mail_source]
                by_source = {page.source_id: page for page in got}
                assert set(by_source) == {str(desk_source.id), str(mail_source.id)}

                (ticket_msg,) = [m for m in by_source[str(desk_source.id)] if f"printer is broken {ts}" in (m.body or "")]
                (mail_msg,) = [m for m in by_source[str(mail_source.id)] if f"invoice question {ts}" in (m.body or "")]
                assert ticket_msg.thread_key == ticket
                assert mail_msg.author_external_id == mailbox["outsider_address"]
                assert desk_source.channel != mail_source.channel
                await _assert_attributed(ticket_msg, desk_source, alice)
                await _assert_attributed(mail_msg, mail_source, alice)

                await by_source[str(desk_source.id)].ack()
                assert (await ConsumerPosition.ensure_for(name, str(mail_source.id))).watermark() is None

                await ticket_msg.reply(await ticket_msg.reply_spec(body=f"try restarting it {ts}"))
                await mail_msg.reply(await mail_msg.reply_spec(body=f"invoice attached {ts}"))

            reply = await _await_hub_message(base, hub_session["api_key"], ticket, containing=f"try restarting it {ts}")
            assert reply is not None and reply["sender_id"] == alice
            mail_reply = await _await_reply(mailbox["outsider_id"], from_address=mailbox["agent_address"])
            assert mail_reply is not None and f"invoice attached {ts}" in (mail_reply.get("text") or mail_reply.get("preview") or "")
    finally:
        for source in sources:
            await source.delete()
        await agent.delete()
