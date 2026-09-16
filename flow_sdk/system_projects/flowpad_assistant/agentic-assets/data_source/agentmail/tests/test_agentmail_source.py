"""The ``agentmail`` data source — the mail transport that can actually send — against a
real-socket AgentMail double.

Pins what makes it different (it sends; a reply uses the reply route with an ENCODED RFC 5322
id; the sent copy is never recorded here), the mapping that keeps everything above it shared, and
where its key lives: a machine secret first, a legacy config key second.
"""
from __future__ import annotations

import json
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote

import pytest
from pydantic import SecretStr

from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.source_registry import asset_module
from flow_sdk.ingest.sources import SendStatus, source_type
from flow_sdk.ingest.testing import local_http_server, position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.testing import Subject, checks_for

SECRET_NAME = asset_module("agentmail").SECRET_NAME
AgentMailSource = asset_module("agentmail").AgentMailSource
address_of = asset_module("agentmail").address_of

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

INBOX = "me@agentmail.to"
MSG = {"message_id": "<abc@email.amazonses.com>", "thread_id": "t-1", "timestamp": "2026-08-02T08:28:47.206Z",
       "from": "Joe the FlowPad agent <joe@agentmail.to>", "to": ["eran@langware.ai"], "subject": "Round trip", "preview": "Hello there."}


class _AgentMail:
    """An inbox: a listing (paged by token), a send route, a reply route. Records what it was asked."""

    def __init__(self, messages=None):
        self.messages, self.requests, self.bodies, self.sent = list(messages or []), [], [], 0

    def __call__(self, path, headers):
        route, _, query = path.partition("?")
        params = {k: v[0] for k, v in parse_qs(query).items()}
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        self.requests.append(route)
        self.bodies.append(body)
        if headers.get("Authorization") != "Bearer am_test":
            return self._json(401, {"error": "bad key"})
        if route.endswith("/messages/send") or route.endswith("/reply"):
            if route.endswith("/reply"):
                answered = unquote(route.split("/messages/")[1][: -len("/reply")])
                parent = next((m for m in self.messages if m["message_id"] == answered), None)
                if parent is None:
                    return self._json(404, {"error": "no such message"})
                thread = parent["thread_id"]
            else:
                thread = f"t-new-{self.sent}"
            self.sent += 1
            sent = {**MSG, "message_id": f"<sent-{self.sent}@x>", "thread_id": thread, "timestamp": f"2026-08-03T00:00:0{self.sent}.000Z"}
            self.messages.append(sent)
            return self._json(200, {"message_id": sent["message_id"], "thread_id": thread})
        start, limit = int(params.get("page_token") or 0), int(params.get("limit") or 25)
        page = self.messages[start:start + limit]
        more = start + limit < len(self.messages)
        return self._json(200, {"messages": page, **({"next_page_token": str(start + limit)} if more else {})})

    @staticmethod
    def _json(status, payload):
        return status, json.dumps(payload).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def mail():
    fake = _AgentMail([MSG])
    with local_http_server(fake) as base:
        fake.base = base
        yield fake


@pytest.fixture(autouse=True)
def _no_store(monkeypatch):
    monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: None)


def _row(mail, **config):
    return SimpleNamespace(id="ds-1", provider="agentmail", name="Agent mailbox", account_key="", account_identities=[],
                           config={"inbox": INBOX, "api_key": "am_test", "base_url": mail.base, **config})


def _view(state=None):
    return position(segment_key=INBOX, prior=state or {}, window_start=None)


@pytest.mark.parametrize("check", checks_for(AgentMailSource), ids=str)
async def test_conformance(check, mail):
    mail.messages = [{**MSG, "message_id": f"<m{n}@x>", "timestamp": f"2026-08-02T0{n}:00:00.000Z"} for n in (1, 2, 3)]
    binding = SourceBinding(config={"inbox": INBOX, "base_url": mail.base}, credentials=Credentials(shape=AuthShape.SECRETS, values={"api_key": SecretStr("am_test")}))
    probe = AgentMailSource(binding)
    await check.run(Subject(
        source=lambda: AgentMailSource(binding),
        seeded=tuple(probe.origin(f"<m{n}@x>") for n in (1, 2, 3)),
        conversation=probe.origin("t-1"),
        recipient=UserProfile(origin=probe.origin("joe@agentmail.to"), address="joe@agentmail.to"),
    ))


class TestTheSource:
    def test_it_sends_on_its_own_channel(self, mail):
        driver = source_type("agentmail")
        assert driver.sends is True and driver.channel_for(_row(mail)) == "agentmail"

    async def test_one_inbox_is_one_segment(self, mail):
        assert [s.key for s in await source_type("agentmail").segments(_row(mail))] == [INBOX]

    async def test_a_missing_inbox_is_a_config_error(self, mail):
        with pytest.raises(Exception) as caught:
            await source_type("agentmail").segments(_row(mail, inbox=""))
        assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR


class TestMapping:
    async def test_the_providers_own_id_the_thread_and_the_sender(self, mail):
        (item,) = (await source_type("agentmail").traverse(_row(mail), _view())).items
        assert (item.external_id, item.thread_key, item.kind) == ("<abc@email.amazonses.com>", "t-1", "content.message.email")
        assert item.author_display == "Joe the FlowPad agent <joe@agentmail.to>"
        assert item.author_external_id == "joe@agentmail.to", "the address is what `_sender_for` compares"
        assert (item.name, item.body, item.recipients) == ("Round trip", "Hello there.", ["eran@langware.ai"])

    def test_a_bare_address_survives_parsing(self):
        assert address_of("joe@agentmail.to") == "joe@agentmail.to" and address_of("") == ""


class TestCursor:
    async def test_only_what_is_newer_than_the_high_water_returns(self, mail):
        mail.messages = [MSG, {**MSG, "message_id": "<old@x>", "timestamp": "2026-08-01T00:00:00.000Z"}]
        result = await source_type("agentmail").traverse(_row(mail), _view({"cursor": AgentMailSource.resume_after("2026-08-02T00:00:00.000Z")}))
        assert [i.external_id for i in result.items] == ["<abc@email.amazonses.com>"]
        assert result.cursor == AgentMailSource.resume_after(MSG["timestamp"])

    async def test_a_legacy_high_water_is_adopted(self, mail):
        result = await source_type("agentmail").traverse(_row(mail), _view({"high_water": MSG["timestamp"]}))
        assert result.items == [] and result.unchanged is True

    async def test_nothing_new_is_reported_unchanged(self, mail):
        mail.messages = []
        assert (await source_type("agentmail").traverse(_row(mail), _view())).unchanged is True


class TestSend:
    async def test_a_reply_uses_the_reply_route_with_an_encoded_id(self, mail):
        out = await source_type("agentmail").send(_row(mail), thread_key="t-1", to="joe@agentmail.to", text="hi", in_reply_to=MSG["message_id"])
        assert "%3Cabc%40email.amazonses.com%3E" in mail.requests[-1] and mail.requests[-1].endswith("/reply")
        assert (out.status, out.external_id) == (SendStatus.SENT, "<sent-1@x>")

    async def test_without_a_parent_it_starts_a_new_message(self, mail):
        await source_type("agentmail").send(_row(mail), thread_key="", to="joe@agentmail.to", text="hi", subject="Hello")
        assert mail.requests[-1].endswith("/messages/send")
        assert (mail.bodies[-1]["to"], mail.bodies[-1]["subject"]) == (["joe@agentmail.to"], "Hello")

    async def test_the_sent_copy_is_not_recorded_here(self, mail):
        out = await source_type("agentmail").send(_row(mail), thread_key="", to="j@x.to", text="hi")
        assert out.recorded is False, "the listing returns the sent copy; recording it here would be the same row twice"


class TestTheKey:
    """A MACHINE credential (the SOD store), not a per-source form field — with the legacy config key
    as the fallback for sources created before the move."""

    async def _headers(self, mail, **config):
        await source_type("agentmail").traverse(_row(mail, **config), _view())
        return mail.requests

    async def test_the_key_comes_from_the_store_without_a_project(self, mail, monkeypatch):
        seen = {}
        monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: seen.setdefault("name", name) and "am_test")
        await source_type("agentmail").traverse(_row(mail, api_key=""), _view())
        assert seen["name"] == SECRET_NAME and mail.requests, "the store's key reached AgentMail"

    async def test_the_store_wins_over_a_legacy_config_key(self, mail, monkeypatch):
        monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: "am_test")
        result = await source_type("agentmail").traverse(_row(mail, api_key="am_wrong"), _view())
        assert result.items, "the store's key was used, so AgentMail answered"

    async def test_a_legacy_config_key_still_works(self, mail):
        assert (await source_type("agentmail").traverse(_row(mail), _view())).items

    async def test_no_key_anywhere_names_the_store(self, mail):
        with pytest.raises(Exception) as caught:
            await source_type("agentmail").traverse(_row(mail, api_key=""), _view())
        assert SECRET_NAME in str(caught.value) and classify(caught.value)[0] is SourceHealth.CONFIG_ERROR

    async def test_a_refused_key_needs_a_person(self, mail):
        with pytest.raises(Exception) as caught:
            await source_type("agentmail").traverse(_row(mail, api_key="am_wrong"), _view())
        assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR
