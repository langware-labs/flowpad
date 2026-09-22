"""One cell of the stream inbox channel matrix, in-process: owner × channel, over the driver's ``Double``.

What a cell proves (the same four things on every surface):

1. an inbound message on the channel lands in THAT owner's stream inbox and nobody else's;
2. the projected message is attributed to its source (``origin_local.data_source_id``) and its
   channel (``origin.kind == source.channel``), and never to us;
3. the reply leaves through the channel — the double records it — and on an agent cell the agent's
   serve loop answers it as the agent;
4. ``StreamInbox(..., owner=…)`` adopts the owner's source rather than minting a twin.

Providers are data here, never branches: every channel goes through the same body, and what differs
per channel (who writes in, whose address it is) the driver's ``Double`` says.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from dataclasses import dataclass
from typing import Any

from flow_sdk.builtin.agent import Agent
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module
from flow_sdk.ingest.sync import sync_source
from flow_sdk.ingest.testing import make_data_source
from flow_sdk.stream_inbox import outbound
from flow_sdk.stream_inbox.agent_scope import resolve_agent_stream_inbox_scope
from flow_sdk.stream_inbox.projection import reconcile_source

#: The channels of the matrix.
CHANNELS = ("gmail", "slack", "whatsapp", "telegram", "cloud_email")
OWNERS = ("user", "agent")


def double_for(provider: str):
    """The driver's own ``Double`` (its ``tests/matrix.py``), entered by the caller."""
    return load_module(SHIPPED_ROOT / provider / "tests", "matrix").Double()


def not_applicable(owner_kind: str, provider: str) -> str:
    """Why a cell has no test, or ``""``: a double that says its address is an agent's has no user cell."""
    double_cls = load_module(SHIPPED_ROOT / provider / "tests", "matrix").Double
    if owner_kind == "user" and getattr(double_cls, "agent_only", False):
        return f"{provider} is an agent's address by definition; a user has no such source"
    return ""


@dataclass
class Cell:
    owner_kind: str
    provider: str
    double: Any
    user: TypeId
    agent: Agent
    source: DataSource
    nonce: str

    @property
    def owner(self) -> TypeId:
        return self.user if self.owner_kind == "user" else self.agent.typeid

    @property
    def other(self) -> TypeId:
        return self.agent.typeid if self.owner_kind == "user" else self.user


async def local_user_typeid() -> TypeId:
    from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415

    return (await get_or_create_local_user()).typeid


async def make_cell(owner_kind: str, provider: str, double, monkeypatch) -> Cell:
    """The owner (the local user or a fresh Agent), the other owner, and a saved source of the
    channel owned by the former, with credentials answered by the double."""
    user = await local_user_typeid()
    agent = Agent(name=f"matrix {provider} {uuid.uuid4().hex[:6]}", worker_type="claude", system_prompt="Be brief.",
                  email_allowed_senders=[double.sender])
    await agent.save()
    owner = user if owner_kind == "user" else agent.typeid

    monkeypatch.setattr(DataDriver.loaded(provider), "credentials_for", double.credentials)
    config = double.config_for(owner) if hasattr(double, "config_for") else dict(double.config)
    source = make_data_source(
        provider, name=f"matrix {owner_kind} {provider} {uuid.uuid4().hex[:6]}", config=config, owner=owner,
        status=SourceStatus.ACTIVE.value, inbound_allowed_senders=[double.sender], **dict(double.fields),
    )
    await source.save()
    # One empty pass: stamps kind/channel and takes the double's first position, so the delivery
    # below is "new since" and not a backfill.
    await sync_source(source)
    cell = Cell(owner_kind, provider, double, user, agent, source, uuid.uuid4().hex[:8])
    _stub_the_turn(cell, monkeypatch)
    return cell


def _stub_the_turn(cell: Cell, monkeypatch) -> None:
    """The worker is a stub that answers with the cell's nonce: the turn engine's
    process for any session is this one, and its reply is read from nowhere but here."""
    from flow_sdk.builtin.agent_serve import TurnEngine  # noqa: PLC0415
    from flow_sdk.schema.data_spec.returned_value_spec import PromptResult  # noqa: PLC0415

    class _Process:
        id = "p-matrix"
        typeid = "agentic_process-p-matrix"

        def __init__(self):
            self.context_data: dict = {}

        async def send_turn(self, _body):
            return PromptResult.satisfied("The turn was accepted.", executor=self.typeid)

        async def save(self):
            pass

    process = _Process()

    async def process_for(self, *_a, **_k):
        return process

    async def capture(_ap):
        return f"agent reply {cell.nonce}"

    monkeypatch.setattr(TurnEngine, "process_for", process_for)
    monkeypatch.setattr("flow_sdk.app.actions.execute_prompt._capture_assistant_reply", capture)


@contextlib.asynccontextmanager
async def agent_serving(cell: Cell):
    """On an agent cell, the agent's placement serves the source for the duration — the real
    loop (drain → gate → turn → reply → ack), on a fast cadence, its position held first as the
    agent server holds it."""
    if cell.owner_kind != "agent":
        yield
        return
    from flow_sdk.builtin.agent_serve import hold_positions, serve  # noqa: PLC0415

    deployment = await cell.agent.local_deployment()
    await hold_positions(deployment, [cell.source])
    loop = asyncio.get_running_loop().create_task(serve(cell.agent, deployment, sources=[cell.source], poll_every=0.02))
    try:
        yield
    finally:
        loop.cancel()
        await asyncio.gather(loop, return_exceptions=True)


async def deliver(cell: Cell) -> SourceItem:
    """An inbound on the channel, ingested the way the backend does it: a webhook push through the
    driver's chokepoint, or a poll."""
    inbound = f"hello {cell.nonce}"
    delivered = cell.double.deliver(inbound, sender=cell.double.sender)
    if delivered.get("path"):
        raw = delivered["body"]
        await DataDriver.loaded(cell.provider).ingest_pushed(cell.source, json.loads(raw), headers=delivered["headers"], raw=raw)
    else:
        await sync_source(cell.source)
    await reconcile_source(str(cell.source.id))
    # Match the delivered TEXT, not the bare nonce: the agent's answer carries the
    # nonce too ("agent reply <nonce>"), and on a channel that echoes a sent message
    # back into the same mailbox it is ingested as its own row. Counting that as a
    # second delivery is how this read "not ingested" when it had been ingested once.
    rows = [r for r in await SourceItem.get_all({"data_source_id": str(cell.source.id)}) if inbound in (r.body or "")]
    assert len(rows) == 1, f"{cell.provider}: the delivery was not ingested ({len(rows)} rows carry it)"
    return rows[0]


async def projected(item: SourceItem) -> tuple[FlowMessage, Conversation]:
    fm = await FlowMessage.get_one({"source_item_id": str(item.id)})
    assert fm is not None, "the item was not projected"
    conversation = await Conversation.get_one({"id": str(fm.conversation_id)})
    assert conversation is not None
    return fm, conversation


async def assert_owned_and_attributed(cell: Cell, item: SourceItem) -> tuple[FlowMessage, Conversation]:
    fm, conversation = await projected(item)
    assert str(conversation.owner) == str(cell.owner), f"landed in {conversation.owner}, not {cell.owner}"
    assert str(conversation.owner) != str(cell.other)
    assert fm.origin is not None and fm.origin.kind == cell.source.channel, (fm.origin, cell.source.channel)
    assert fm.origin_local is not None and str(fm.origin_local.data_source_id) == str(cell.source.id)
    assert str(fm.sender_id) != cell.user.id, "an inbound message is never attributed to us"
    # The agent stream inbox's gate: its scope holds the conversation iff the agent owns the source.
    scope = await resolve_agent_stream_inbox_scope(cell.agent.id)
    assert (str(conversation.id) in set(map(str, scope.conversation_ids))) == (cell.owner_kind == "agent")
    return fm, conversation


async def reply_as_human(cell: Cell, conversation: Conversation) -> dict:
    """The composer's path: ``send_external`` → ``dispatch_channel_reply``; the send is a task."""
    before = len(cell.double.sent())
    response = await outbound.dispatch_channel_reply(str(conversation.id), text=f"reply {cell.nonce}")
    assert getattr(response, "status", "") != "FAIL", getattr(response, "message", response)
    await asyncio.gather(*list(outbound._INFLIGHT))
    sent = cell.double.sent()
    assert len(sent) == before + 1, f"{cell.provider}: the reply never left ({sent})"
    assert f"reply {cell.nonce}" in (sent[-1]["text"] or "")
    return sent[-1]


async def reply_as_agent(cell: Cell, item: SourceItem) -> dict:
    """The serve loop's path: the delivered message becomes a turn; the worker is a stub that
    answers with the nonce; the answer leaves through the channel as the agent. The loop is
    already running (`agent_serving`) — this waits for its answer to reach the double."""
    reply = f"agent reply {cell.nonce}"
    for _ in range(200):  # the loop's cadence is 20 ms; this is ~4 s of them
        sent = [m for m in cell.double.sent() if reply in (m["text"] or "")]
        if sent:
            assert len(sent) == 1, f"{cell.provider}: answered {len(sent)} times"
            return sent[0]
        await asyncio.sleep(0.02)
    raise AssertionError(f"{cell.provider}: the agent's serve loop never answered ({cell.double.sent()})")


async def adopts_the_owners_source(cell: Cell, monkeypatch) -> None:
    from flow_sdk.blocks import StreamInbox  # noqa: PLC0415

    async def held(_provider):  # the block's connection precheck; the double IS the connection here
        return None

    monkeypatch.setattr("flow_sdk.connections.require", held)
    key = DataDriver.loaded(cell.provider).identity_config_key
    address = str(cell.source.config.get(key) or cell.source.account_key or "")
    box = StreamInbox(address, provider=cell.provider, owner=cell.owner)
    assert (await box.ensure_source()).id == cell.source.id, "the block must adopt the cell's source, not mint a twin"
