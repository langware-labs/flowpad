"""The ``conversations`` data source: the hub conversations an agent was invited to in, its answers out.

Offline by construction — the hub is a transport the source is handed, so these hand it a fake
one. The traps: every record carries the hub's OWN ids (or the projection mints a twin beside the
row the hub bridge mirrored); every read and answer goes through the AGENT's ``conversation_router``
(the machine's Identity holds no role on a conversation); only a plain conversation is read (a ticket
belongs to the help-desk source); the agent's own message is its own; and a person's login reads
nothing at all.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import NamedTuple, Optional

import pytest

from flow_sdk.builtin.agent_serve import is_own_outgoing
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.errors import AccessDenied, NotFound, Rejected
from flow_sdk.sources.hub_conversations import try_resolve_login_agent
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import MessageData

ConversationsSource = asset_module("conversations").ConversationsSource
REJECTED = asset_module("conversations").REJECTED
ROUTER = asset_module("conversations").ROUTER

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
    sub_path: str


class _Hub:
    """A hub whose agent's ``conversation_router`` lists the conversations it holds, answers each one's messages
    and takes an answer as the agent; every call is recorded. The router answers only its own agent."""

    def __init__(self, rows=None, threads=None, *, agent: str = AGENT):
        self.rows = list(rows or [])
        self.threads: dict[str, list[dict]] = {k: list(v) for k, v in (threads or {}).items()}
        self.signed_in_agent = agent
        self.calls: list[Call] = []

    def _route(self, entity_type: str, entity_id: str, action: str) -> None:
        if (entity_type, action) != ("agent", ROUTER):
            raise AccessDenied(f"the machine holds no role on {entity_type}/{entity_id}/{action}")
        if not entity_id or entity_id != self.signed_in_agent:
            raise AccessDenied("not this machine's agent")

    async def get(self, entity_type, entity_id, action, *, params=None, sub_path=None):
        self.calls.append(Call("get", entity_type, entity_id, action, sub_path or ""))
        self._route(entity_type, entity_id, action)
        if not sub_path:
            return list(self.rows)
        conversation, _, leaf = sub_path.partition("/")
        assert leaf == "messages", f"test setup failure: unexpected router read {sub_path!r}"
        return self.threads.get(conversation, [])

    async def post(self, entity_type, payload, entity_id, action, *, sub_path=None):
        self.calls.append(Call("post", entity_type, entity_id, action, sub_path or ""))
        self._route(entity_type, entity_id, action)
        conversation, _, leaf = (sub_path or "").partition("/")
        assert leaf == "add_message", f"test setup failure: unexpected router post {sub_path!r}"
        if conversation not in self.threads or payload.get("conversation_id") != conversation:
            raise NotFound("no such conversation")
        sent = {
            "id": str(uuid.uuid4()),
            "text": payload["text"],
            "sender_id": self.signed_in_agent,  # the router posts as the agent, not the machine's Identity
            "created_date": "2026-09-06T11:00:00+00:00",
            "updated_date": "2026-09-06T11:00:00+00:00",
        }
        self.threads[conversation].append(sent)
        return sent

    def me(self) -> str:
        return self.signed_in_agent or PERSON

    async def agent(self) -> str:
        return self.signed_in_agent

    def reads(self) -> list[str]:
        return [c.sub_path.removesuffix("/messages") for c in self.calls if c.sub_path.endswith("/messages")]

    def posts(self) -> list[Call]:
        return [c for c in self.calls if c.verb == "post"]


def _answer(conversation: str) -> Call:
    """The router post that answers ``conversation`` as the agent."""
    return Call("post", "agent", AGENT, ROUTER, f"{conversation}/add_message")


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

    async def test_the_list_and_the_messages_are_read_through_the_agents_router(self, monkeypatch, hub):
        await _serve(monkeypatch, hub).traverse(_row(), position())
        assert hub.calls == [
            Call("get", "agent", AGENT, ROUTER, ""),
            Call("get", "agent", AGENT, ROUTER, f"{CONVERSATION}/messages"),
        ], "the machine's Identity holds no role on a conversation: only the agent's router reaches it"

    async def test_an_older_page_of_one_conversation_is_read_through_the_router(self, hub):
        async with ConversationsSource(SourceBinding(config={}), hub=hub) as source:
            before = datetime(2026, 9, 7, tzinfo=timezone.utc)
            page = await source.fetch(
                None, narrow={"conversation": source.conversation_origin(CONVERSATION), "before": before}
            )
        assert [i.data.hub_message_id for i in page.items] == [MSG["id"]]
        assert hub.calls == [Call("get", "agent", AGENT, ROUTER, f"{CONVERSATION}/messages")]


class TestAnswering:
    async def test_a_reply_is_posted_to_the_conversation_without_a_pickup(self, monkeypatch, hub):
        driver = _serve(monkeypatch, hub)
        out = await driver.send(_row(), thread_key=CONVERSATION, to=CONVERSATION, text="the build is green")
        assert hub.posts() == [_answer(CONVERSATION)]
        assert out.recorded is True and out.external_id == hub.threads[CONVERSATION][-1]["id"]

    async def test_a_reply_to_one_message_goes_to_its_conversation_as_the_agent(self, hub):
        async with ConversationsSource(SourceBinding(config={}), hub=hub) as source:
            (asked,) = (await source.fetch(None)).items
            sent = await source.reply(asked.origin, MessageData(text="the build is green"))
        assert hub.posts() == [_answer(CONVERSATION)]
        assert sent.data.hub_conversation_id == CONVERSATION and sent.data.in_reply_to == asked.origin
        assert sent.data.sender is not None and sent.data.sender.origin.key == AGENT, "the router posts as the agent"


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


class TestTheAgentItAnswersAs:
    """The agent id the router is addressed by: the subject of the Identity this machine is signed in as when that
    is an agent, else the main agent of the Deployment that is (the box's adopted copy of the hub's row)."""

    DEPLOYMENT = "33333333-3333-4333-8333-333333333333"

    @staticmethod
    def _signed_in_as(monkeypatch: pytest.MonkeyPatch, principal: Optional[dict]) -> None:
        monkeypatch.setattr("flow_sdk.cli.app_config.get_principal", lambda: principal)

    @staticmethod
    def _deployment_here(monkeypatch: pytest.MonkeyPatch, rows: dict[str, SimpleNamespace]) -> None:
        async def get_by_id(_cls, deployment_id: str) -> Optional[SimpleNamespace]:
            return rows.get(deployment_id)

        monkeypatch.setattr(Deployment, "get_by_id", classmethod(get_by_id))

    @staticmethod
    def _identity(subject_typeid: str) -> dict:
        return {"id": PERSON, "type": "identity", "typeid": f"identity-{PERSON}", "subject_typeid": subject_typeid}

    async def test_a_deployment_identity_answers_as_the_deployments_main_agent(self, monkeypatch):
        self._signed_in_as(monkeypatch, self._identity(f"deployment-{self.DEPLOYMENT}"))
        self._deployment_here(monkeypatch, {self.DEPLOYMENT: SimpleNamespace(main_agent_id=f"agent-{AGENT}")})
        assert await try_resolve_login_agent() == AGENT

    async def test_an_agent_identity_answers_as_its_agent(self, monkeypatch):
        self._signed_in_as(monkeypatch, self._identity(f"agent-{AGENT}"))
        self._deployment_here(monkeypatch, {})
        assert await try_resolve_login_agent() == AGENT

    @pytest.mark.parametrize(
        "principal",
        [
            None,
            {"id": PERSON, "type": "user", "typeid": f"user-{PERSON}"},
            {"id": PERSON, "type": "identity", "typeid": f"identity-{PERSON}"},
        ],
        ids=["signed-out", "a-person", "no-subject"],
    )
    async def test_no_agent_identity_answers_as_none(self, monkeypatch, principal):
        self._signed_in_as(monkeypatch, principal)
        assert await try_resolve_login_agent() is None

    async def test_a_deployment_not_on_this_machine_answers_as_none(self, monkeypatch):
        self._signed_in_as(monkeypatch, self._identity(f"deployment-{self.DEPLOYMENT}"))
        self._deployment_here(monkeypatch, {})
        assert await try_resolve_login_agent() is None


class TestRecoveryOnSignIn:
    """As the help desk's: a source parked because its login could not read answers again once this machine reads
    the agent's conversation router (``ensure_sources``, run on sign-in and start). A box signs in afresh on every
    resume, so a source parked once must not stay parked."""

    @staticmethod
    async def _park_source(code: str) -> DataSource:
        source = DataDriver.loaded("conversations").create_source({}, name=f"Conversations {uuid.uuid4().hex[:6]}")
        source.health = SourceHealth.CONFIG_ERROR.value
        source.error_code = code
        await source.save()
        return source

    @staticmethod
    def _sign_in_as(monkeypatch: pytest.MonkeyPatch, agent: Optional[str], *, router_answers: bool = True) -> None:
        async def call(
            method: str, entity_type: str, entity_id: str, action: str, *_a: object, **_k: object
        ) -> list[dict]:
            assert (method, entity_type, entity_id, action) == ("GET", "agent", agent, ROUTER)
            if not router_answers:
                raise HubError(401, "Forbidden access")
            return [ROW]

        async def resolve() -> Optional[str]:
            return agent

        monkeypatch.setattr(HubProxy, "call", staticmethod(call))
        monkeypatch.setattr(asset_module("conversations"), "try_resolve_login_agent", resolve)

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

    async def test_a_refused_router_read_leaves_it_parked(self, monkeypatch: pytest.MonkeyPatch):
        source = await self._park_source(REJECTED)
        self._sign_in_as(monkeypatch, AGENT, router_answers=False)

        await ConversationsSource.ensure_sources()

        assert await self._health_of(source) == SourceHealth.CONFIG_ERROR.value

    async def test_a_source_parked_for_another_reason_stays_parked(self, monkeypatch: pytest.MonkeyPatch):
        source = await self._park_source("not_found")
        self._sign_in_as(monkeypatch, AGENT)

        await ConversationsSource.ensure_sources()

        assert await self._health_of(source) == SourceHealth.CONFIG_ERROR.value
