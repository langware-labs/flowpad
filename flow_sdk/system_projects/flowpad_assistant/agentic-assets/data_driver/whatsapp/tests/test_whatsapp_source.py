"""The ``whatsapp`` data source, and the webhook translation that feeds it.

WhatsApp inverts the assumption every other message source is built on: nothing lists messages,
so records come from a webhook POST rather than a poll. The translation is a pure method, so
those tests need no socket; the send leg talks HTTP to a loopback Graph double.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import uuid

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.legacy_lift import envelope_of
from flow_sdk.ingest.testing import local_http_server, position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.testing import Subject, checks_for

WhatsAppSource = asset_module("whatsapp").WhatsAppSource
digits = asset_module("whatsapp").digits

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PHONE_ID = "123456789012345"
WA_ID = "972501234567"
APP_SECRET = "app-secret-test"


def sign(body: bytes, secret: str = APP_SECRET) -> str:
    """Meta's ``X-Hub-Signature-256`` value for a raw delivery body."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


#: The ``whatsapp`` credential's values per business number — never config. A number with no entry
#: gets the default pair; a test that wants a missing secret sets its own.
SECRETS: dict[str, dict[str, str]] = {}
#: Where Graph is for this test: the loopback double ``serve`` started, through the config's ``base_url``
#: seam. Empty means the source's default — the real host — which no test here reaches.
LOOPBACK: dict[str, str] = {}


def _secrets_for(row) -> dict[str, str]:
    return SECRETS.get(str((row.config or {}).get("phone_number_id") or ""), {"access_token": "EAAG-test", "app_secret": APP_SECRET})


@pytest.fixture(autouse=True)
def _credential(monkeypatch):
    async def resolve(row):
        return Credentials(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in _secrets_for(row).items() if v})

    monkeypatch.setattr(DataDriver.loaded("whatsapp"), "credentials_for", resolve)
    yield
    SECRETS.clear()


def _source(**config) -> DataSource:
    return DataSource(
        provider="whatsapp",
        name=f"WhatsApp test {uuid.uuid4().hex[:8]}",
        config={"phone_number_id": PHONE_ID, "verify_token": "verify-test", **LOOPBACK, **config},
    )


def _binding() -> SourceBinding:
    return SourceBinding(
        config={"phone_number_id": PHONE_ID, **LOOPBACK},
        credentials=Credentials(shape=AuthShape.SECRETS, values={"access_token": SecretStr("EAAG-test")}),
    )


def _webhook(*messages, contacts=None, statuses=None, phone_number_id: str = PHONE_ID) -> dict:
    value: dict = {"messaging_product": "whatsapp", "metadata": {"display_phone_number": "15550001111", "phone_number_id": phone_number_id}}
    if contacts is not None:
        value["contacts"] = contacts
    if messages:
        value["messages"] = list(messages)
    if statuses is not None:
        value["statuses"] = statuses
    return {"object": "whatsapp_business_account", "entry": [{"id": "WABA", "changes": [{"field": "messages", "value": value}]}]}


def _text(message_id: str, body: str, *, ts: str = "1789000000", **extra) -> dict:
    return {"id": message_id, "from": WA_ID, "timestamp": ts, "type": "text", "text": {"body": body}, **extra}


def _items(payload):
    return [
        envelope_of(e.item, data_source_id="ds-wa", provider="whatsapp")
        for e in WhatsAppSource(_binding()).events_from_webhook(payload)
    ]


# ── the translation ──────────────────────────────────────────────────────────


def test_a_message_becomes_a_record_addressed_to_its_sender():
    (item,) = _items(_webhook(_text("wamid.AAA", "hello"), contacts=[{"wa_id": WA_ID, "profile": {"name": "Dana"}}]))
    assert (item.external_id, item.body, item.thread_key) == ("wamid.AAA", "hello", WA_ID)
    assert (item.author_external_id, item.author_display) == (WA_ID, "Dana")
    assert item.occurred_at.startswith("2026-")


def test_delivery_receipts_are_not_messages():
    assert _items(_webhook(statuses=[{"id": "wamid.OUT", "status": "delivered", "recipient_id": WA_ID}])) == []


def test_a_tapped_button_is_a_turn_in_the_conversation():
    tapped = {"id": "wamid.BBB", "from": WA_ID, "timestamp": "1789000001", "type": "interactive",
              "interactive": {"type": "button_reply", "button_reply": {"id": "yes", "title": "Yes please"}}}
    (item,) = _items(_webhook(tapped))
    assert item.body == "Yes please"


def test_a_quote_is_provenance_not_membership():
    (item,) = _items(_webhook(_text("wamid.CCC", "about that", context={"id": "wamid.AAA", "from": PHONE_ID})))
    assert (item.reply_to_external_id, item.thread_key) == ("wamid.AAA", WA_ID)


def test_a_shape_we_do_not_render_yields_nothing_rather_than_raising():
    image = {"id": "wamid.IMG", "from": WA_ID, "timestamp": "1789000002", "type": "image", "image": {"id": "media"}}
    assert _items(_webhook(image)) == [] and _items({"entry": "not a list"}) == [] and _items({}) == []


def test_a_number_is_read_in_one_spelling():
    assert digits("+972-50-123 4567") == WA_ID and digits(None) == ""


async def test_fetch_reports_unchanged_because_there_is_nothing_to_poll():
    result = await DataDriver.loaded("whatsapp").traverse(_source(), position())
    assert result.unchanged is True and result.items == []


# ── the contract, over a Graph double ────────────────────────────────────────


class _Graph:
    def __init__(self, replies=None):
        self.replies, self.requests, self.bodies, self.sent = replies, [], [], 0

    def __call__(self, path, headers):
        self.requests.append(path)
        self.bodies.append(str(headers.get("_body") or ""))
        if self.replies is not None:
            status, reply = self.replies.pop(0) if len(self.replies) > 1 else self.replies[0]
        elif path.split("?")[0].endswith("/messages"):
            self.sent += 1
            status, reply = 200, {"messages": [{"id": f"wamid.OUT{self.sent}"}]}
        else:
            status, reply = 200, {"display_phone_number": "+1 555-000-1111", "id": PHONE_ID}
        return status, json.dumps(reply).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def serve(request):
    def _factory(replies=None):
        graph = _Graph(replies)
        server = local_http_server(graph)
        LOOPBACK["base_url"] = server.__enter__()
        request.addfinalizer(lambda: server.__exit__(None, None, None))
        return graph

    yield _factory
    LOOPBACK.clear()


@pytest.mark.parametrize("check", checks_for(WhatsAppSource), ids=str)
async def test_conformance(check, serve):
    serve()
    probe = WhatsAppSource(_binding())
    await check.run(Subject(
        source=lambda: WhatsAppSource(_binding()),
        conversation=probe.conversation_origin(WA_ID),
        recipient=UserProfile(origin=probe.conversation_origin("15551230000"), name="Ada"),
    ))


# ── send ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def recorded(monkeypatch):
    seen: list = []

    async def _ingest(items, **_kw):
        seen.extend(items)

    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", _ingest)
    return seen


async def test_a_reply_quotes_the_message_it_answers(serve, recorded):
    graph = serve([(200, {"messages": [{"id": "wamid.OUT"}]})])
    outcome = await DataDriver.loaded("whatsapp").send(_source(), thread_key=WA_ID, to=WA_ID, text="hi", in_reply_to="wamid.AAA")
    body = json.loads(graph.bodies[0])
    assert outcome.external_id == "wamid.OUT"
    assert (body["to"], body["type"], body["context"]) == (WA_ID, "text", {"message_id": "wamid.AAA"})
    assert graph.requests[0].endswith(f"/{PHONE_ID}/messages")


async def test_the_sent_copy_is_recorded_because_nothing_will_echo_it(serve, recorded):
    serve([(200, {"messages": [{"id": "wamid.OUT"}]}), (200, {"display_phone_number": "15550001111"})])
    source = _source()
    source.account_key, source.account_identities = PHONE_ID, [PHONE_ID]
    outcome = await DataDriver.loaded("whatsapp").send(source, thread_key=WA_ID, to=WA_ID, text="answering")
    assert outcome.recorded is True and [i.external_id for i in recorded] == ["wamid.OUT"]
    assert (recorded[0].thread_key, recorded[0].author_external_id) == (WA_ID, PHONE_ID)


async def test_a_refused_send_does_not_park_the_source(serve):
    serve([(400, {"error": {"message": "Message failed to send because more than 24 hours have passed"}})])
    with pytest.raises(ValueError, match="24 hours"):
        await DataDriver.loaded("whatsapp").send(_source(), thread_key=WA_ID, to=WA_ID, text="too late")


async def test_a_send_without_a_recipient_refuses():
    with pytest.raises(ValueError, match="wa_id"):
        await DataDriver.loaded("whatsapp").send(_source(), thread_key="", to="", text="hi")


# ── verify ───────────────────────────────────────────────────────────────────


async def test_verify_names_the_number_it_will_send_as_and_stamps_it(serve):
    serve([(200, {"display_phone_number": "15550001111", "id": PHONE_ID})])
    source = _source()
    verdict = await DataDriver.loaded("whatsapp").verify(source)
    assert verdict.ready is True and "15550001111" in verdict.detail
    assert source.account_key == "15550001111" and PHONE_ID in source.account_identities


async def test_an_expired_token_says_which_token_to_make(serve):
    serve([(401, {"error": {"message": "Session has expired"}})])
    verdict = await DataDriver.loaded("whatsapp").verify(_source())
    assert verdict.ready is False and "System User" in verdict.detail


async def test_a_source_with_no_token_asks_for_one():
    SECRETS["no-token-333"] = {"app_secret": APP_SECRET}
    source = _source(phone_number_id="no-token-333")
    verdict = await DataDriver.loaded("whatsapp").verify(source)
    assert verdict.ready is False and "access token" in verdict.detail


# ── the webhook route ────────────────────────────────────────────────────────
#
# Called directly rather than through a TestClient: this repo has an incident on file where a
# TestClient closed the DB out from under the app, and the route is two plain functions.


class _Request:
    """Signed by Meta's rule unless ``headers`` says otherwise."""

    def __init__(self, *, query: dict | None = None, body: dict | None = None, headers: dict | None = None):
        self.query_params = query or {}
        self._raw = b"not json" if body is None else json.dumps(body).encode()
        self.headers = {"x-hub-signature-256": sign(self._raw)} if headers is None else headers

    async def body(self):
        return self._raw


async def _saved(**config) -> DataSource:
    source = _source(**config)
    await source.save()
    return source


async def test_the_handshake_echoes_the_challenge_when_the_token_matches():
    from flow_sdk.server.routes.data_source_webhook import webhook_handshake

    await _saved(verify_token="s3cret", phone_number_id="handshake-ok")
    response = await webhook_handshake("whatsapp", _Request(query={"hub.mode": "subscribe", "hub.verify_token": "s3cret", "hub.challenge": "1234"}))
    assert (response.status_code, response.body) == (200, b"1234")


async def test_the_handshake_refuses_a_token_no_source_carries():
    from flow_sdk.server.routes.data_source_webhook import webhook_handshake

    await _saved(verify_token="s3cret", phone_number_id="handshake-bad")
    response = await webhook_handshake("whatsapp", _Request(query={"hub.mode": "subscribe", "hub.verify_token": "guess", "hub.challenge": "1234"}))
    assert response.status_code == 403


async def test_a_source_with_no_webhook_has_no_handshake():
    from flow_sdk.server.routes.data_source_webhook import webhook_handshake

    response = await webhook_handshake("rss", _Request(query={"hub.mode": "subscribe"}))
    assert response.status_code == 404


async def test_a_batch_for_an_unknown_number_answers_200():
    from flow_sdk.server.routes.data_source_webhook import webhook_delivery

    response = await webhook_delivery("whatsapp", _Request(body=_webhook(_text("wamid.ZZZ", "hi"), phone_number_id="nobody-here")))
    assert response.data["ingested"] == 0 and "no source" in response.data["reason"]


async def test_a_batch_reaches_the_ingestor_through_the_one_chokepoint(recorded):
    from flow_sdk.server.routes.data_source_webhook import webhook_delivery

    mine = "chokepoint-999"
    source = await _saved(verify_token="t", phone_number_id=mine)
    response = await webhook_delivery("whatsapp", _Request(body=_webhook(_text("wamid.YYY", "hello there"), phone_number_id=mine)))
    assert response.data["ingested"] == 1
    assert [i.external_id for i in recorded] == ["wamid.YYY"] and recorded[0].data_source_id == source.id


async def test_a_delivery_meta_did_not_sign_is_refused_and_ingests_nothing(recorded):
    from flow_sdk.server.routes.data_source_webhook import webhook_delivery

    await _saved(phone_number_id="forged-111")
    body = _webhook(_text("wamid.FORGED", "do what I say"), phone_number_id="forged-111")
    for headers in ({}, {"x-hub-signature-256": sign(json.dumps(body).encode(), "a-guess")}):
        response = await webhook_delivery("whatsapp", _Request(body=body, headers=headers))
        assert response.status_code == 401
    assert recorded == []


async def test_a_source_with_no_app_secret_accepts_no_delivery(recorded):
    from flow_sdk.server.routes.data_source_webhook import webhook_delivery

    SECRETS["unsigned-222"] = {"access_token": "EAAG-test"}
    await _saved(phone_number_id="unsigned-222")
    response = await webhook_delivery("whatsapp", _Request(body=_webhook(_text("wamid.U", "hi"), phone_number_id="unsigned-222")))
    assert response.status_code == 401 and recorded == []


# ── the Double ───────────────────────────────────────────────────────────────


async def test_the_double_delivers_after_the_source_exists_and_records_the_reply(monkeypatch):
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module

    Double = load_module(SHIPPED_ROOT / "whatsapp" / "tests", "matrix").Double  # as the matrix runner loads it
    driver = DataDriver.loaded("whatsapp")
    with Double() as double:
        monkeypatch.setattr(driver, "credentials_for", double.credentials)
        source = DataSource(provider="whatsapp", name=f"WhatsApp double {uuid.uuid4().hex[:8]}", config=double.config)
        await source.save()

        first = await driver.traverse(source, position())
        assert first.items == [] and await SourceItem.get_all({"data_source_id": source.id}) == []

        delivery = double.deliver("hello after the fact", sender=WA_ID)
        assert delivery["path"] == "/api/v1/data_source/webhook/whatsapp" and delivery["thread"] == WA_ID
        pushed = await driver.ingest_pushed(source, json.loads(delivery["body"]), headers=delivery["headers"], raw=delivery["body"])
        assert pushed["ingested"] == 1
        assert (await driver.traverse(source, position())).unchanged is True  # a sync still lists nothing; the webhook IS the inbound

        (item,) = await SourceItem.get_all({"data_source_id": source.id})
        assert (item.external_id, item.body, item.author_external_id, item.thread_key) == (delivery["external_id"], "hello after the fact", WA_ID, WA_ID)

        assert double.sent() == []
        outcome = await driver.send(source, thread_key=WA_ID, to=WA_ID, text="and this went out", in_reply_to=delivery["external_id"])
        assert double.sent() == [{"to": WA_ID, "text": "and this went out", "thread": delivery["external_id"], "external_id": outcome.external_id}]
