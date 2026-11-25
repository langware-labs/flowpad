"""The ``conversations`` data source: the hub conversations an agent's Identity is a member of in,
its answers out.

Offline by construction — the hub is a transport the source is handed, so these hand it a fake
one. The traps: every record carries the hub's OWN ids (or the projection mints a twin beside the
row the hub bridge mirrored); only a plain conversation is read (a ticket belongs to the help-desk
source); the agent's own message is its own; and a person's login reads nothing at all.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from types import SimpleNamespace
from typing import NamedTuple, Optional

import pytest

from flow_sdk.builtin.agent_serve import is_own_outgoing
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import NotFound, Rejected
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import MessageData

ConversationsSource = asset_module("conversations").ConversationsSource
REJECTED = asset_module("conversations").REJECTED

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

CONVERSATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
TICKET = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
AGENT = "11111111-1111-4111-8111-111111111111"
PERSON = "22222222-2222-4222-8222-222222222222"
ROW = {
    "id": CONVERSATION,
    "kind": "direct",
    "status": "open",
    "message_count": 1,
    "updated_date": "2026-09-06T10:00:00+00:00",
}
MSG = {
    "id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    "text": "what is the status of the build?",
    "sender_id": PERSON,
    "sender_name": "Alice",
    "created_date": "2026-09-06T10:00:00+00:00",
    "updated_date": "2026-09-06T10:00:00+00:00",
}


class Call(NamedTuple):
    """One request the fake hub was asked."""

    verb: str
    entity_type: str
    entity_id: str
    action: str


class _Hub:
    """A hub that lists the conversations it holds, answers each one's messages and records every call."""

    def __init__(self, rows=None, threads=None, *, agent: str = AGENT):
        self.rows = list(rows or [])
        self.threads: dict[str, list[dict]] = {k: list(v) for k, v in (threads or {}).items()}
        self.signed_in_agent = agent
        self.calls: list[Call] = []

    async def walk(self, entity_type):
        self.calls.append(Call("walk", entity_type, "", ""))
        return list(self.rows)

    async def get(self, entity_type, entity_id, action, *, params=None):
        self.calls.append(Call("get", entity_type, entity_id, action))
        return self.threads.get(entity_id, [])

    async def post(self, entity_type, payload, entity_id, action):
        self.calls.append(Call("post", entity_type, entity_id, action))
        if entity_id not in self.threads:
            raise NotFound("no such conversation")
        sent = {
            "id": str(uuid.uuid4()),
            "text": payload["text"],
            "sender_id": self.signed_in_agent,
            "created_date": "2026-09-06T11:00:00+00:00",
            "updated_date": "2026-09-06T11:00:00+00:00",
        }
        self.threads[entity_id].append(sent)
        return sent

    def me(self) -> str:
        return self.signed_in_agent or PERSON

    def agent(self) -> str:
        return self.signed_in_agent

    def reads(self) -> list[str]:
        return [c.entity_id for c in self.calls if c.action == "messages"]

    def posts(self) -> list[Call]:
        return [c for c in self.calls if c.verb == "post"]


def _row(identities: Optional[list[str]] = None):
    return SimpleNamespace(
        id=f"ds-{uuid.uuid4().hex[:8]}",
        name="Agent conversations",
        provider="conversations",
        config={},
        account_key="",
        account_identities=list(identities or []),
        status="active",
    )


def _serve(monkeypatch, hub):
    monkeypatch.setattr(ConversationsSource, "build", classmethod(lambda cls, binding: cls(binding, hub=hub)))
    return DataDriver.loaded("conversations")


@pytest.fixture
def hub():
    return _Hub([ROW], {CONVERSATION: [MSG]})


@pytest.mark.parametrize("check", checks_for(ConversationsSource), ids=str)
async def test_conformance(check):
    fake = _Hub(
        [ROW],
        {
            CONVERSATION: [
                {
                    **MSG,
                    "id": f"m{n}",
                    "created_date": f"2026-09-06T10:0{n}:00+00:00",
                    "updated_date": f"2026-09-06T10:0{n}:00+00:00",
                }
                for n in (1, 2, 3)
            ]
        },
    )
    binding = SourceBinding(config={})
    probe = ConversationsSource(binding, hub=fake)
    await check.run(
        Subject(
            source=lambda: ConversationsSource(binding, hub=fake),
            conversation=probe.conversation_origin(CONVERSATION),
            recipient=UserProfile(origin=probe.origin(PERSON), name="Alice"),
        )
    )


class TestTheSource:
    def test_it_is_registered_sends_and_admits_every_member(self):
        driver = DataDriver.loaded("conversations")
        assert driver.sends is True and driver.open_inbound is True
        assert getattr(driver.cls, "answers_once", False) is False, "every turn's text is the reply"

    def test_the_manifest_matches_the_source(self):
        folder = Path(__file__).resolve().parents[1]
        manifest = json.loads((folder / "data_driver.json").read_text())
        assert manifest["name"] == ConversationsSource.provider == folder.name
        assert "traits" not in manifest, "a builtin never declares traits"


class TestReading:
    async def test_a_new_message_is_fetched_once_with_the_hub_ids_on_it(self, monkeypatch, hub):
        driver = _serve(monkeypatch, hub)
        first = await driver.traverse(_row(), position())
        (item,) = first.items
        assert item.external_id == MSG["id"] and item.message_id == MSG["id"], (
            "the projection lands on the hub's own message id"
        )
        assert item.conversation_id == CONVERSATION, "the projection adopts the mirrored conversation"
        assert (item.thread_key, item.body) == (CONVERSATION, MSG["text"])
        assert (item.author_external_id, item.author_display) == (PERSON, "Alice")
        again = await driver.traverse(_row(), position(first))
        assert again.items == [] and again.unchanged is True

    async def test_an_idle_conversation_is_not_read_again(self, monkeypatch, hub):
        driver = _serve(monkeypatch, hub)
        first = await driver.traverse(_row(), position())
        hub.calls.clear()
        await driver.traverse(_row(), position(first))
        assert hub.reads() == [], "the list says nothing moved, so the conversation costs no fetch"
        reply = {**MSG, "id": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "text": "and the deploy?"}
        reply["created_date"] = reply["updated_date"] = "2026-09-06T10:05:00+00:00"
        hub.threads[CONVERSATION].append(reply)
        hub.rows = [{**ROW, "message_count": 2, "updated_date": reply["updated_date"]}]
        second = await driver.traverse(_row(), position(first))
        assert [i.external_id for i in second.items] == [reply["id"]]
        assert hub.reads() == [CONVERSATION]

    @pytest.mark.parametrize("kind", ["helpdesk", "it", "monitoring"])
    async def test_only_a_plain_conversation_is_read(self, monkeypatch, kind):
        other = {**ROW, "id": TICKET, "kind": kind}
        fake = _Hub([ROW, other], {CONVERSATION: [MSG], TICKET: [{**MSG, "id": "t1"}]})
        result = await _serve(monkeypatch, fake).traverse(_row(), position())
        assert [i.thread_key for i in result.items] == [CONVERSATION]
        assert fake.reads() == [CONVERSATION], f"a {kind} conversation belongs to another source"

    async def test_a_deleted_conversation_is_not_read(self, monkeypatch):
        fake = _Hub([{**ROW, "deleted_at": "2026-09-06T10:30:00+00:00"}], {CONVERSATION: [MSG]})
        result = await _serve(monkeypatch, fake).traverse(_row(), position())
        assert result.items == [] and fake.reads() == []


class TestAnswering:
    async def test_a_reply_is_posted_to_the_conversation_without_a_pickup(self, monkeypatch, hub):
        driver = _serve(monkeypatch, hub)
        out = await driver.send(_row(), thread_key=CONVERSATION, to=CONVERSATION, text="the build is green")
        assert hub.posts() == [Call("post", "conversation", CONVERSATION, "add_message")]
        assert out.recorded is True and out.external_id == hub.threads[CONVERSATION][-1]["id"]

    async def test_a_reply_to_one_message_goes_to_its_conversation(self, hub):
        async with ConversationsSource(SourceBinding(config={}), hub=hub) as source:
            (asked,) = (await source.fetch(None)).items
            sent = await source.reply(asked.origin, MessageData(text="the build is green"))
        assert hub.posts() == [Call("post", "conversation", CONVERSATION, "add_message")]
        assert sent.data.hub_conversation_id == CONVERSATION and sent.data.in_reply_to == asked.origin


class TestTheLoopGuard:
    async def test_the_agent_is_who_the_source_answers_as(self, hub):
        async with ConversationsSource(SourceBinding(config={}), hub=hub) as source:
            (me,) = await source.whoami()
        assert me.origin.key == AGENT

    async def test_the_agents_own_message_is_recognised_as_its_own(self, monkeypatch):
        own = {**MSG, "id": "m-own", "sender_id": AGENT, "sender_name": "Agent"}
        fake = _Hub([ROW], {CONVERSATION: [MSG, own]})
        row = _row([AGENT])
        result = await _serve(monkeypatch, fake).traverse(row, position())
        authors = {i.external_id: i.author_external_id for i in result.items}
        assert is_own_outgoing(row, authors["m-own"]) is True, "the loop never answers the agent's own message"
        assert is_own_outgoing(row, authors[MSG["id"]]) is False


class TestAPersonsLogin:
    """A person's own conversations are never an agent's to read or answer."""

    async def test_nothing_is_read(self, monkeypatch):
        fake = _Hub([ROW], {CONVERSATION: [MSG]}, agent="")
        with pytest.raises(Exception) as caught:
            await _serve(monkeypatch, fake).traverse(_row(), position())
        assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR and "agent" in str(caught.value)
        assert fake.calls == []

    async def test_nothing_is_sent(self):
        fake = _Hub([ROW], {CONVERSATION: [MSG]}, agent="")
        async with ConversationsSource(SourceBinding(config={}), hub=fake) as source:
            outgoing, _answered = source.message_for(thread_key=CONVERSATION, to=CONVERSATION, text="hello")
            with pytest.raises(Exception) as caught:
                await source.send(outgoing)
            assert await source.whoami() == ()
        assert "agent" in str(caught.value) and fake.calls == []


class TestRecoveryOnSignIn:
    """As the help desk's: a source parked because its login could not read answers again once this machine reads
    the conversation list as an agent (``ensure_sources``, run on sign-in and start). A box signs in afresh on every
    resume, so a source parked once must not stay parked."""

    @staticmethod
    async def _park_source(code: str) -> DataSource:
        source = DataDriver.loaded("conversations").create_source({}, name=f"Conversations {uuid.uuid4().hex[:6]}")
        source.health = SourceHealth.CONFIG_ERROR.value
        source.error_code = code
        await source.save()
        return source

    @staticmethod
    def _sign_in_as(monkeypatch: pytest.MonkeyPatch, agent: Optional[str], *, walk_complete: bool = True) -> None:
        async def walk(_entity_type: str) -> SimpleNamespace:
            return SimpleNamespace(rows=[ROW], complete=walk_complete)

        monkeypatch.setattr(HubProxy, "walk", walk)
        monkeypatch.setattr(asset_module("conversations"), "try_read_agent_login", lambda: agent)

    @staticmethod
    async def _health_of(source: DataSource) -> Optional[str]:
        stored = await DataSource.get_by_id(str(source.id))
        assert stored is not None, "test setup failure: the source is gone"
        return stored.health

    def test_the_parked_code_is_the_one_a_rejected_read_is_given(self):
        assert classify(Rejected("not an agent"))[1] == REJECTED

    @pytest.mark.parametrize("code", [REJECTED, "access_denied"])
    async def test_a_source_parked_by_a_login_that_could_not_read_answers_again_once_signed_in_as_the_agent(
        self, monkeypatch: pytest.MonkeyPatch, code: str
    ):
        source = await self._park_source(code)
        self._sign_in_as(monkeypatch, AGENT)

        assert await ConversationsSource.ensure_sources() == 0, "it makes no source: the creator adds it"
        assert await self._health_of(source) != SourceHealth.CONFIG_ERROR.value

    async def test_a_signed_out_machine_leaves_it_parked(self, monkeypatch: pytest.MonkeyPatch):
        source = await self._park_source(REJECTED)
        self._sign_in_as(monkeypatch, None)

        await ConversationsSource.ensure_sources()

        assert await self._health_of(source) == SourceHealth.CONFIG_ERROR.value

    async def test_an_unfinished_walk_leaves_it_parked(self, monkeypatch: pytest.MonkeyPatch):
        source = await self._park_source(REJECTED)
        self._sign_in_as(monkeypatch, AGENT, walk_complete=False)

        await ConversationsSource.ensure_sources()

        assert await self._health_of(source) == SourceHealth.CONFIG_ERROR.value

    async def test_a_source_parked_for_another_reason_stays_parked(self, monkeypatch: pytest.MonkeyPatch):
        source = await self._park_source("not_found")
        self._sign_in_as(monkeypatch, AGENT)

        await ConversationsSource.ensure_sources()

        assert await self._health_of(source) == SourceHealth.CONFIG_ERROR.value
