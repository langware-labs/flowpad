"""The ``agentmail`` data source — the mail transport that can actually send — against a
real-socket AgentMail double.

Pins what makes it different (it sends; a reply uses the reply route with an ENCODED RFC 5322
id; the sent copy is never recorded here), the mapping that keeps everything above it shared, and
where its key lives: a machine secret first, a legacy config key second.
"""
from __future__ import annotations

import base64
import json
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.driver_runtime import SendStatus
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import local_http_server, position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.files import local_file
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import FileItem, FileKind, MessageData, MessageFileData

SECRET_NAME = asset_module("agentmail").SECRET_NAME
AgentMailSource = asset_module("agentmail").AgentMailSource
address_of = asset_module("agentmail").address_of

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

INBOX = "me@agentmail.to"
MSG = {"message_id": "<abc@email.amazonses.com>", "thread_id": "t-1", "timestamp": "2026-08-02T08:28:47.206Z",
       "from": "Joe the FlowPad agent <joe@agentmail.to>", "to": ["eran@langware.ai"], "subject": "Round trip", "preview": "Hello there."}
MAP = b"\x89PNG\r\n\x1a\n" + bytes(range(256))
LOG = b"%PDF-1.4 the captain's log"
#: A listed message with files, as AgentMail reports them: metadata only, the bytes behind a signed URL.
WITH_FILES = {**MSG, "message_id": "<files@x>", "in_reply_to": "<question@x>", "attachments": [
    {"attachment_id": "att-map", "filename": "map.png", "content_type": "image/png", "size": len(MAP), "content_disposition": "attachment"},
    {"attachment_id": "att-log", "filename": "log.pdf", "content_type": "application/pdf", "size": len(LOG), "content_disposition": "attachment"},
]}
BLOBS = {"att-map": MAP, "att-log": LOG}


class _AgentMail:
    """An inbox: a listing (paged by token), a send route, a reply route. Records what it was asked."""

    def __init__(self, messages=None):
        self.messages, self.requests, self.bodies, self.sent, self.downloads = list(messages or []), [], [], 0, []

    def __call__(self, path, headers):
        route, _, query = path.partition("?")
        params = {k: v[0] for k, v in parse_qs(query).items()}
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        self.requests.append(route)
        self.bodies.append(body)
        if route.startswith("/signed/"):
            # The signed URL is its own authority: record whether our key leaked onto it.
            self.downloads.append(headers.get("Authorization"))
            return 200, BLOBS[route[len("/signed/"):]], {"Content-Type": "application/octet-stream"}
        if headers.get("Authorization") != "Bearer am_test":
            return self._json(401, {"error": "bad key"})
        if "/attachments/" in route:
            message_id, attachment_id = (unquote(p) for p in route.split("/messages/")[1].split("/attachments/"))
            parent = next((m for m in self.messages if m["message_id"] == message_id), None)
            if parent is None or not any(a["attachment_id"] == attachment_id for a in parent.get("attachments") or []):
                return self._json(404, {"error": "no such attachment"})
            return self._json(200, {"attachment_id": attachment_id, "download_url": f"{self.base}/signed/{attachment_id}"})
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
    """The key lives in the machine store; a test that wants none (or a wrong one) says so."""
    monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: "am_test")


def _row(mail, **config):
    return SimpleNamespace(id="ds-1", provider="agentmail", name="Agent mailbox", account_key="", account_identities=[],
                           config={"inbox": INBOX, "base_url": mail.base, **config})


def _view(prior=None, *, cursor=None):
    return position(prior, cursor=cursor)


@pytest.mark.parametrize("check", checks_for(AgentMailSource), ids=str)
async def test_conformance(check, mail):
    mail.messages = [{**MSG, "message_id": f"<m{n}@x>", "timestamp": f"2026-08-02T0{n}:00:00.000Z"} for n in (1, 2, 3)]
    mail.messages.append({**WITH_FILES, "timestamp": "2026-08-01T00:00:00.000Z"})
    probe = AgentMailSource(_binding(mail))
    await check.run(Subject(
        source=lambda: AgentMailSource(_binding(mail)),
        seeded=tuple(probe.origin(f"<m{n}@x>") for n in (1, 2, 3)),
        conversation=probe.origin("t-1"),
        recipient=UserProfile(origin=probe.origin("joe@agentmail.to"), address="joe@agentmail.to"),
        inbound_file=FileItem(origin=probe.origin("<files@x>#att-map"), data=MessageFileData()),
        inbound_bytes=MAP,
    ))


def _binding(mail):
    return SourceBinding(config={"inbox": INBOX, "base_url": mail.base}, credentials=ResolvedSecrets(shape=AuthShape.SECRETS, values={"api_key": SecretStr("am_test")}))


async def _read(source, file) -> bytes:
    async with source.open(file) as chunks:
        return b"".join([chunk async for chunk in chunks])


class TestTheSource:
    def test_it_sends_on_its_own_channel(self, mail):
        driver = DataDriver.loaded("agentmail")
        assert driver.sends is True and driver.channel_for(_row(mail)) == "agentmail"

    def test_the_query_is_the_whole_inbox(self, mail):
        query = AgentMailSource(SourceBinding(config={"inbox": INBOX, "base_url": mail.base})).query()
        assert (query.conversation, query.since) == (None, None)

    async def test_a_missing_inbox_is_a_config_error(self, mail):
        with pytest.raises(Exception) as caught:
            await DataDriver.loaded("agentmail").traverse(_row(mail, inbox=""), _view())
        assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR


class TestMapping:
    async def test_the_providers_own_id_the_thread_and_the_sender(self, mail):
        (item,) = (await DataDriver.loaded("agentmail").traverse(_row(mail), _view())).items
        assert (item.external_id, item.thread_key, item.kind) == ("<abc@email.amazonses.com>", "t-1", "content.message.email")
        assert item.author_display == "Joe the FlowPad agent <joe@agentmail.to>"
        assert item.author_external_id == "joe@agentmail.to", "the address is what `_sender_for` compares"
        assert (item.name, item.body, item.recipients) == ("Round trip", "Hello there.", ["eran@langware.ai"])

    async def test_listed_attachments_and_the_answered_message_map(self, mail):
        mail.messages = [WITH_FILES]
        async with AgentMailSource(_binding(mail)) as source:
            (item,) = (await source.fetch()).items
            assert item.data.in_reply_to == source.origin("<question@x>")
            chart, log = item.data.attachments
            assert [(f.origin.key, f.data.name, f.data.media_type, f.data.size, f.data.as_) for f in (chart, log)] == [
                ("<files@x>#att-map", "map.png", "image/png", len(MAP), FileKind.IMAGE),
                ("<files@x>#att-log", "log.pdf", "application/pdf", len(LOG), FileKind.DOCUMENT),
            ]
            assert (await _read(source, chart), await _read(source, log)) == (MAP, LOG)
        assert "/inboxes/me@agentmail.to/messages/%3Cfiles%40x%3E/attachments/att-map" in mail.requests
        assert mail.downloads == [None, None], "the signed URL is fetched without our key"

    async def test_a_message_without_attachments_or_a_parent_maps_none(self, mail):
        (item,) = (await DataDriver.loaded("agentmail").traverse(_row(mail), _view())).items
        assert item.reply_to_external_id in (None, "")

    async def test_an_attachment_the_provider_does_not_know_is_not_found(self, mail):
        async with AgentMailSource(_binding(mail)) as source:
            with pytest.raises(Exception) as caught:
                await _read(source, FileItem(origin=source.origin(f"{MSG['message_id']}#att-gone"), data=MessageFileData()))
        assert type(caught.value).__name__ == "NotFound"

    def test_a_bare_address_survives_parsing(self):
        assert address_of("joe@agentmail.to") == "joe@agentmail.to" and address_of("") == ""


class TestCursor:
    async def test_only_what_is_newer_than_the_high_water_returns(self, mail):
        mail.messages = [MSG, {**MSG, "message_id": "<old@x>", "timestamp": "2026-08-01T00:00:00.000Z"}]
        result = await DataDriver.loaded("agentmail").traverse(_row(mail), _view(cursor=AgentMailSource.resume_after("2026-08-02T00:00:00.000Z")))
        assert [i.external_id for i in result.items] == ["<abc@email.amazonses.com>"]
        assert result.cursor == AgentMailSource.resume_after(MSG["timestamp"])

    async def test_nothing_new_is_reported_unchanged(self, mail):
        mail.messages = []
        assert (await DataDriver.loaded("agentmail").traverse(_row(mail), _view())).unchanged is True


class TestSend:
    async def test_a_reply_uses_the_reply_route_with_an_encoded_id(self, mail):
        out = await DataDriver.loaded("agentmail").send(_row(mail), thread_key="t-1", to="joe@agentmail.to", text="hi", in_reply_to=MSG["message_id"])
        assert "%3Cabc%40email.amazonses.com%3E" in mail.requests[-1] and mail.requests[-1].endswith("/reply")
        assert (out.status, out.external_id) == (SendStatus.SENT, "<sent-1@x>")

    async def test_without_a_parent_it_starts_a_new_message(self, mail):
        await DataDriver.loaded("agentmail").send(_row(mail), thread_key="", to="joe@agentmail.to", text="hi", subject="Hello")
        assert mail.requests[-1].endswith("/messages/send")
        assert (mail.bodies[-1]["to"], mail.bodies[-1]["subject"]) == (["joe@agentmail.to"], "Hello")

    async def test_files_ride_the_reply_base64_encoded_in_one_request(self, mail, tmp_path):
        (chart := tmp_path / "map.png").write_bytes(MAP)
        (log := tmp_path / "log.pdf").write_bytes(LOG)
        out = await DataDriver.loaded("agentmail").send(
            _row(mail), thread_key="t-1", to="joe@agentmail.to", text="The map and the log.", in_reply_to=MSG["message_id"],
            files=(local_file(chart), local_file(log)),
        )
        assert mail.requests[-1].endswith("%3Cabc%40email.amazonses.com%3E/reply") and out.parts == ("<sent-1@x>",)
        body = mail.bodies[-1]
        assert body["text"] == "The map and the log."
        assert [(a["filename"], a["content_type"], base64.b64decode(a["content"])) for a in body["attachments"]] == [
            ("map.png", "image/png", MAP), ("log.pdf", "application/pdf", LOG),
        ]

    async def test_a_file_without_text_sends_an_empty_body(self, mail, tmp_path):
        (chart := tmp_path / "map.png").write_bytes(MAP)
        async with AgentMailSource(_binding(mail)) as source:
            to = UserProfile(origin=source.origin("joe@agentmail.to"), address="joe@agentmail.to")
            sent = await source.send(MessageData(recipients=(to,), attachments=(local_file(chart),)))
        assert mail.bodies[-1]["text"] == "" and base64.b64decode(mail.bodies[-1]["attachments"][0]["content"]) == MAP
        assert sent.data.text is None and [f.data.name for f in sent.data.attachments] == ["map.png"]

    async def test_a_text_send_carries_no_attachments_key(self, mail):
        await DataDriver.loaded("agentmail").send(_row(mail), thread_key="", to="joe@agentmail.to", text="hi")
        assert "attachments" not in mail.bodies[-1]

    async def test_the_sent_copy_is_recorded_on_the_key_the_listing_returns(self, mail):
        out = await DataDriver.loaded("agentmail").send(_row(mail), thread_key="", to="j@x.to", text="hi")
        assert out.recorded is True, "on record at send; the listing's copy has the same message_id, so it lands on this row"


class TestTheKey:
    """A MACHINE credential (the SOD store), never a per-source form field: a config is value-free."""

    async def _headers(self, mail, **config):
        await DataDriver.loaded("agentmail").traverse(_row(mail, **config), _view())
        return mail.requests

    async def test_the_key_comes_from_the_store_without_a_project(self, mail, monkeypatch):
        seen = {}
        monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: seen.setdefault("name", name) and "am_test")
        await DataDriver.loaded("agentmail").traverse(_row(mail), _view())
        assert seen["name"] == SECRET_NAME and mail.requests, "the store's key reached AgentMail"

    async def test_a_key_in_the_config_is_never_read(self, mail, monkeypatch):
        """A config is value-free: a key written there reaches nothing."""
        monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: None)
        with pytest.raises(Exception) as caught:
            await DataDriver.loaded("agentmail").traverse(_row(mail, api_key="am_test"), _view())
        assert SECRET_NAME in str(caught.value)

    async def test_no_key_anywhere_names_the_store(self, mail, monkeypatch):
        monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: None)
        with pytest.raises(Exception) as caught:
            await DataDriver.loaded("agentmail").traverse(_row(mail), _view())
        assert SECRET_NAME in str(caught.value) and classify(caught.value)[0] is SourceHealth.CONFIG_ERROR

    async def test_a_refused_key_needs_a_person(self, mail, monkeypatch):
        monkeypatch.setattr("flow_sdk.cli.auth.secrets.read_secret", lambda name: "am_wrong")
        with pytest.raises(Exception) as caught:
            await DataDriver.loaded("agentmail").traverse(_row(mail), _view())
        assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR


async def test_the_double_carries_files_both_ways(monkeypatch, tmp_path):
    from pathlib import Path

    from flow_sdk.ingest.driver_registry import load_module

    Double = load_module(Path(__file__).parent, "matrix").Double  # as the matrix runner loads it
    driver = DataDriver.loaded("agentmail")
    with Double() as double:
        row = SimpleNamespace(id="ds-double", provider="agentmail", name="Agent mailbox", account_key="", account_identities=[], config=double.config)
        delivered = double.deliver("The map.", sender="sailor@example.com", files=[{"name": "map.png", "media_type": "image/png", "bytes": MAP}])
        async with await driver.open(row) as source:
            (item,) = (await source.fetch()).items
            (chart,) = item.data.attachments
            assert chart.data.name == "map.png" and await _read(source, chart) == MAP
        (log := tmp_path / "log.pdf").write_bytes(LOG)
        await driver.send(row, thread_key="", to="sailor@example.com", text="The log.", in_reply_to=delivered["external_id"], files=(local_file(log),))
        (sent,) = double.sent()
        assert sent["thread"] == delivered["thread"] and sent["files"] == [{"name": "log.pdf", "media_type": "application/pdf", "bytes": LOG}]
