"""Which agentic process (AP) a Slack message is answered in — the same answer polled and pushed.

One user, one channel, the two ways the ``slack`` driver receives it: **polling** (a channel read as a
bot, ``SlackSource.fetch``, on a monotonic mock clock) and **webhook** (the person's own app, the hub
handing each event to ``SlackSource.events_from_webhook``). Every case runs on both and must agree.

Real: the driver, ``envelope_of``, the projection's ``resolve_thread`` and ``TurnEngine.process_for``.
In memory: Slack's Web API, the thread and process rows, and ``Deployment.create_process`` (recorded,
not run). CPU only — no hub, no socket, no database.
"""
from __future__ import annotations

import itertools
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.envelope_lift import envelope_of
from flow_sdk.schema.types import EntityType
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.values.items import MessageItem
from flow_sdk.stream_inbox.projection import channel_of, owner_of, resolve_thread, thread_key_for

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SlackSource = asset_module("slack").SlackSource

TEAM, CHANNEL, USER, BOT = "T1", "C0PARITY1", "U0USER001", "U0BOT0001"
AGENT = TypeId(type=EntityType.AGENT.value, id="370da5cb-3c78-4c6e-8c64-22e6642ce74e")
#: How far the mock clock moves between two polls.
POLL_SECONDS = 300.0


# ── Slack, in memory ─────────────────────────────────────────────────────────


class MonotonicClock:
    """Slack's ``ts`` source: only ever moves forward, and only when the test moves it."""

    def __init__(self, start: float = 1_800_000_000.0):
        self.now = start

    def advance(self, seconds: float = 1.0) -> str:
        self.now += seconds
        return f"{self.now:.6f}"


class Workspace:
    """One channel as Slack keeps it: history lists roots (a thread's count and newest reply on it, never
    the replies), ``conversations.replies`` lists a thread, and every message is also pushed as an event."""

    def __init__(self, clock: MonotonicClock):
        self.clock = clock
        self.messages: list[dict] = []
        self.events: list[dict] = []

    def post(self, text: str, *, user: str, thread_ts: str = "") -> dict:
        message = {"type": "message", "user": user, "ts": self.clock.advance(), "text": text}
        if thread_ts:
            message["thread_ts"] = thread_ts
        self.messages.append(message)
        self.events.append({"team_id": TEAM, "event": {**message, "channel": CHANNEL, "channel_type": "channel"}})
        return message

    def _root(self, message: dict) -> dict:
        replies = [m["ts"] for m in self.messages if m.get("thread_ts") == message["ts"] and m["ts"] != message["ts"]]
        if not replies:
            return message
        return {**message, "thread_ts": message["ts"], "reply_count": len(replies), "latest_reply": max(replies, key=float)}

    async def api(self, method: str, payload: dict, *, verb: str = "GET", token: str = "") -> dict:
        if method == "auth.test":
            return {"ok": True, "user_id": BOT, "bot_id": "B1", "user": "q", "team_id": TEAM}
        if method == "chat.postMessage":
            sent = self.post(payload["text"], user=BOT, thread_ts=payload.get("thread_ts") or "")
            return {"ok": True, "ts": sent["ts"], "channel": payload["channel"]}
        if method == "conversations.history":
            roots = [self._root(m) for m in self.messages if m.get("thread_ts") in (None, m["ts"])]
            if payload.get("oldest"):
                roots = [m for m in roots if float(m["ts"]) > float(payload["oldest"])]
            roots.sort(key=lambda m: float(m["ts"]), reverse=True)
            return {"ok": True, "messages": roots[: int(payload.get("limit") or 100)], "response_metadata": {"next_cursor": ""}}
        if method == "conversations.replies":
            root, floor = payload["ts"], float(payload.get("oldest") or 0)
            thread = [m for m in self.messages if m["ts"] == root or (m.get("thread_ts") == root and float(m["ts"]) > floor)]
            return {"ok": True, "messages": sorted(thread, key=lambda m: float(m["ts"])), "response_metadata": {"next_cursor": ""}}
        return {"ok": False, "error": "unknown_method"}


# ── the two ways the driver receives ────────────────────────────────────────


class Polling:
    """A channel read as a bot: one ``fetch`` per poll, from the cursor the last poll left."""

    name = "polling"

    def __init__(self, slack: Workspace):
        self.slack, self.cursor, self.seen = slack, None, set()
        self.source = SlackSource(SourceBinding(
            account_key=TEAM, config={"channel": CHANNEL},
            credentials=ResolvedSecrets(shape=AuthShape.SECRETS, values={"SLACK_BOT_TOKEN": SecretStr("xoxb-test")}),
        ))
        self.source._api = slack.api

    async def arrivals(self) -> list[MessageItem]:
        """What the next poll lands that was not landed before (ingest keeps one row per message)."""
        self.slack.clock.advance(POLL_SECONDS)
        page = await self.source.fetch(self.cursor)
        self.cursor = page.resume_cursor or self.cursor
        new = [i for i in page.items if isinstance(i, MessageItem) and i.origin.key not in self.seen]
        self.seen.update(i.origin.key for i in new)
        return new


class Webhook:
    """The person's own app: each Slack event, as the hub hands it over."""

    name = "webhook"

    def __init__(self, slack: Workspace):
        self.slack, self.handed = slack, 0
        self.source = SlackSource(SourceBinding(
            account_key=TEAM, config={"team_id": TEAM, "user_id": USER},
            credentials=ResolvedSecrets(shape=AuthShape.SECRETS, values={"SLACK_USER_TOKEN": SecretStr("xoxp-test")}),
        ))
        self.source._api = slack.api

    async def arrivals(self) -> list[MessageItem]:
        pending, self.handed = self.slack.events[self.handed:], len(self.slack.events)
        return [e.item for payload in pending for e in self.source.events_from_webhook(payload) if isinstance(e.item, MessageItem)]


# ── Flowpad's rows, in memory ───────────────────────────────────────────────


class Rows:
    """The thread and process rows the real code reads and writes, and every ``create_process`` call."""

    def __init__(self):
        self.threads: dict[tuple, MessageThread] = {}
        self.processes: list[SimpleNamespace] = []
        self.created: list[dict] = []
        self._ids = itertools.count(1)

    async def find_existing(self, channel, thread_key, owner, data_source_id):
        return self.threads.get((channel, thread_key, str(owner), data_source_id))

    async def local_rows(self, query: dict) -> list:
        match = query.get("match") or {}
        found = [p for p in self.processes if all(getattr(p, k) == v for k, v in match.items())]
        return list(reversed(found))  # newest first

    async def create_process(self, prompt: str, **kwargs):
        """Recorded, never run: a row with the fields ``find_process`` reads."""
        self.created.append(kwargs)
        process = SimpleNamespace(
            id=f"ap-{next(self._ids)}", status="stopped", deployment_id=DEPLOYMENT.id, shell_id=None, cli_config={},
            target_typeid_str=kwargs["target_typeid_str"], workdir=kwargs["workdir"],
            visible=kwargs["visible"], pty_mode=kwargs["pty_mode"],
        )
        process.save = _no_write
        self.processes.append(process)
        return process


async def _no_write(*_args, **_kwargs):
    return None


class _Agent:
    id, name, model = AGENT.id, "qa-cycle-manager", None

    @classmethod
    async def get_by_id(cls, _id):
        return None


DEPLOYMENT = SimpleNamespace(id="580bea72-a5c6-412a-a02e-73dd1e7fc915", overrides_for=lambda _agent: {})
#: The ``Slack bot`` row as routing reads it: its channel, its owner (the agent), its id.
SOURCE = SimpleNamespace(id="a971983b-2cc5-42c3-a70d-b435cffe29b2", channel="slack", provider="slack", owner=AGENT)


@pytest.fixture
def rows(monkeypatch) -> Rows:
    rows = Rows()

    async def save(thread, *_args, **_kwargs):
        rows.threads[(thread.channel, thread.thread_key, str(thread.owner), thread.data_source_id)] = thread

    @asynccontextmanager
    async def transaction():
        yield

    async def none(*_args, **_kwargs):
        return None

    monkeypatch.setattr(MessageThread, "find_existing", rows.find_existing)
    monkeypatch.setattr(MessageThread, "find_unclaimed", none)
    monkeypatch.setattr(MessageThread, "save", save)
    monkeypatch.setattr("flow_sdk.db.get_db_driver", lambda: SimpleNamespace(write_transaction=transaction))
    monkeypatch.setattr(AgenticProcess, "local_rows", rows.local_rows)
    DEPLOYMENT.create_process = rows.create_process
    return rows


class Flowpad:
    """A message from the driver to the AP that answers it: placed in its thread the way the projection
    places it, its session named the way ``answer_one`` names it, its AP picked by ``process_for``."""

    def __init__(self, receiver, rows: Rows):
        from flow_sdk.builtin.agent_serve import TurnEngine

        self.receiver, self.rows = receiver, rows
        self.engine = TurnEngine(_Agent(), DEPLOYMENT, workdir="/agent")

    async def place(self, item: MessageItem) -> str:
        """The conversation ``item`` lands in (``project_source_item``'s thread step)."""
        spec = envelope_of(item, data_source_id=SOURCE.id, provider="slack")
        thread = await resolve_thread(
            channel_of(SOURCE), thread_key_for(spec, spec.name or ""), await owner_of(SOURCE),
            data_source_id=SOURCE.id, title=spec.body or "", conversation_id=str(spec.conversation_id or ""),
        )
        return thread.conversation_id

    async def answer(self, item: MessageItem):
        """The AP that answers ``item``."""
        session = str(TypeId(type=EntityType.CONVERSATION.value, id=await self.place(item)))
        return await self.engine.process_for(session, name="qa-cycle-manager · slack")

    async def user_arrivals(self) -> list[MessageItem]:
        return [i for i in await self.receiver.arrivals() if i.data.sender is not None and i.data.sender.origin.key == USER]

    async def agent_posts_top_level(self, process, text: str) -> MessageItem:
        """``process`` writes a new top-level message from its own conversation; its sent copy is placed."""
        conversation = TypeId(process.target_typeid_str).id
        source = self.receiver.source
        data, answered = source.message_for(thread_key="", to=CHANNEL, text=text, conversation_id=conversation)
        assert answered is None
        sent = await source.send(data)
        await self.place(sent)
        return sent


@pytest.fixture(params=[Polling, Webhook], ids=["polling", "webhook"])
async def flowpad(request, rows):
    slack = Workspace(MonotonicClock())
    receiver = request.param(slack)
    async with receiver.source:
        app = Flowpad(receiver, rows)
        assert await app.user_arrivals() == [], "an empty channel landed something"
        app.slack = slack
        yield app


# ── the cases ────────────────────────────────────────────────────────────────


async def _top_level(flowpad: Flowpad, text: str):
    """The user writes ``text`` at the top of the channel: the message as it lands, and its AP."""
    flowpad.slack.post(text, user=USER)
    (message,) = await flowpad.user_arrivals()
    return message, await flowpad.answer(message)


async def test_a_top_level_message_gets_a_fresh_ap(flowpad: Flowpad, rows: Rows):
    message, ap = await _top_level(flowpad, "is the tester alive?")

    assert len(rows.created) == 1, "no fresh AP was asked for"
    (call,) = rows.created
    assert call["target_typeid_str"] == ap.target_typeid_str and ap is rows.processes[0]
    assert message.data.conversation.key == message.origin.key, "a top-level message roots its own thread"


async def test_a_reply_in_the_thread_reuses_the_messages_ap(flowpad: Flowpad, rows: Rows):
    message, ap = await _top_level(flowpad, "cpu and ram?")

    flowpad.slack.post("spin up more testers", user=USER, thread_ts=message.origin.key)
    replies = await flowpad.user_arrivals()

    assert [r.data.text for r in replies] == ["spin up more testers"], f"the thread reply never reached Flowpad ({flowpad.receiver.name})"
    assert await flowpad.answer(replies[0]) is ap, "the reply got another AP"
    assert len(rows.created) == 1, "a fresh AP was asked for the reply"


@pytest.mark.xfail(strict=True, reason="Slack's message_for drops the sending conversation, so the agent's own message opens a new one")
async def test_a_reply_to_the_agents_top_level_message_reuses_the_ap_that_wrote_it(flowpad: Flowpad, rows: Rows):
    _, ap = await _top_level(flowpad, "give status")
    status = await flowpad.agent_posts_top_level(ap, "QA flowpad: iteration i08 is running")

    flowpad.slack.post("why is p12 red?", user=USER, thread_ts=status.origin.key)
    replies = await flowpad.user_arrivals()

    assert [r.data.text for r in replies] == ["why is p12 red?"], f"the thread reply never reached Flowpad ({flowpad.receiver.name})"
    assert await flowpad.answer(replies[0]) is ap, "the reply to the agent's message got another AP than the one that wrote it"
    assert len(rows.created) == 1, "a fresh AP was asked for the reply to the agent's message"
