"""The ``whatsapp`` data source, and the webhook translation that feeds it.

WhatsApp inverts the assumption every other message source is built on: nothing lists messages,
so records come from a webhook POST rather than a poll. The translation is a pure method, so
those tests need no socket; the send leg talks HTTP to a loopback Graph double.
"""
from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.legacy_lift import envelope_of
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.driver_types import driver_type
from flow_sdk.ingest.testing import local_http_server, position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.testing import Subject, checks_for

MESSAGES_SEGMENT = asset_module("whatsapp").MESSAGES_SEGMENT
WhatsAppSource = asset_module("whatsapp").WhatsAppSource
digits = asset_module("whatsapp").digits
wa_source = asset_module("whatsapp")

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

PHONE_ID = "123456789012345"
WA_ID = "972501234567"
APP_SECRET = "app-secret-test"


def sign(body: bytes, secret: str = APP_SECRET) -> str:
    """Meta's ``X-Hub-Signature-256`` value for a raw delivery body."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _source(**config) -> DataDriver:
    return DataDriver(provider="whatsapp", name="WhatsApp test", config={"phone_number_id": PHONE_ID, "access_token": "EAAG-test", "app_secret": APP_SECRET, **config})


def _binding() -> SourceBinding:
    return SourceBinding(
        config={"phone_number_id": PHONE_ID}, credentials=Credentials(shape=AuthShape.SECRETS, values={"access_token": SecretStr("EAAG-test")})
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
        envelope_of(e.item, data_source_id="ds-wa", provider="whatsapp", segment_key=MESSAGES_SEGMENT)
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
    result = await driver_type("whatsapp").traverse(_source(), position(segment_key="messages", prior={}, window_start=None))
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
def serve(monkeypatch, request):
    def _factory(replies=None):
        graph = _Graph(replies)
        server = local_http_server(graph)
        monkeypatch.setattr(wa_source, "GRAPH_API_BASE", server.__enter__())
        request.addfinalizer(lambda: server.__exit__(None, None, None))
        return graph

    return _factory


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
    outcome = await driver_type("whatsapp").send(_source(), thread_key=WA_ID, to=WA_ID, text="hi", in_reply_to="wamid.AAA")
    body = json.loads(graph.bodies[0])
    assert outcome.external_id == "wamid.OUT"
    assert (body["to"], body["type"], body["context"]) == (WA_ID, "text", {"message_id": "wamid.AAA"})
    assert graph.requests[0].endswith(f"/{PHONE_ID}/messages")


async def test_the_sent_copy_is_recorded_because_nothing_will_echo_it(serve, recorded):
    serve([(200, {"messages": [{"id": "wamid.OUT"}]}), (200, {"display_phone_number": "15550001111"})])
    source = _source()
    source.account_key, source.account_identities = PHONE_ID, [PHONE_ID]
    outcome = await driver_type("whatsapp").send(source, thread_key=WA_ID, to=WA_ID, text="answering")
    assert outcome.recorded is True and [i.external_id for i in recorded] == ["wamid.OUT"]
    assert (recorded[0].thread_key, recorded[0].author_external_id) == (WA_ID, PHONE_ID)


async def test_a_refused_send_does_not_park_the_source(serve):
    serve([(400, {"error": {"message": "Message failed to send because more than 24 hours have passed"}})])
    with pytest.raises(ValueError, match="24 hours"):
        await driver_type("whatsapp").send(_source(), thread_key=WA_ID, to=WA_ID, text="too late")


async def test_a_send_without_a_recipient_refuses():
    with pytest.raises(ValueError, match="wa_id"):
        await driver_type("whatsapp").send(_source(), thread_key="", to="", text="hi")


# ── verify ───────────────────────────────────────────────────────────────────


async def test_verify_names_the_number_it_will_send_as_and_stamps_it(serve):
    serve([(200, {"display_phone_number": "15550001111", "id": PHONE_ID})])
    source = _source()
    verdict = await driver_type("whatsapp").verify(source)
    assert verdict.ready is True and "15550001111" in verdict.detail
    assert source.account_key == "15550001111" and PHONE_ID in source.account_identities


async def test_an_expired_token_says_which_token_to_make(serve):
    serve([(401, {"error": {"message": "Session has expired"}})])
    verdict = await driver_type("whatsapp").verify(_source())
    assert verdict.ready is False and "System User" in verdict.detail


async def test_a_source_with_no_token_asks_for_one():
    source = _source()
    source.config = {"phone_number_id": PHONE_ID}
    verdict = await driver_type("whatsapp").verify(source)
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


async def _saved(**config) -> DataDriver:
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

    await _saved(phone_number_id="unsigned-222", app_secret="")
    response = await webhook_delivery("whatsapp", _Request(body=_webhook(_text("wamid.U", "hi"), phone_number_id="unsigned-222")))
    assert response.status_code == 401 and recorded == []
