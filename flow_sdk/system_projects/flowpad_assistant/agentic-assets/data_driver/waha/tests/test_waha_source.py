"""The ``waha`` data source: WAHA's webhook translation, the session it keeps, and the send leg.

The translation is a pure method, so those tests need no socket; verify and send talk HTTP to a
loopback WAHA double that answers the session and ``sendText`` routes.
"""
from __future__ import annotations

import hashlib
import hmac
import json

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.legacy_lift import envelope_of
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.driver_types import driver_type
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.testing import Subject, checks_for

waha = asset_module("waha")
WahaSource = waha.WahaSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

SESSION = "default"
PHONE = "972501234567"
CHAT = f"{PHONE}@c.us"
LID = "123456789012345@lid"
ME = "15550001111"
API_KEY = "waha-test-key"
HMAC_KEY = "waha-hmac-test"
HOOK = "http://host.docker.internal:6001/api/v1/data_source/webhook/waha"


def sign(body: bytes, key: str = HMAC_KEY) -> str:
    """WAHA's ``X-Webhook-Hmac`` for a raw delivery body."""
    return hmac.new(key.encode(), body, hashlib.sha512).hexdigest()


def _config(base: str = "http://127.0.0.1:9", **extra) -> dict:
    return {"base_url": base, "session": SESSION, "webhook_url": HOOK, "api_key": API_KEY, "webhook_hmac": HMAC_KEY, **extra}


def _source(base: str = "http://127.0.0.1:9", **extra) -> DataSource:
    return DataSource(provider="waha", name="WAHA test", config=_config(base, **extra))


def _binding(base: str = "http://127.0.0.1:9") -> SourceBinding:
    values = {"api_key": SecretStr(API_KEY), "webhook_hmac": SecretStr(HMAC_KEY)}
    return SourceBinding(config=_config(base), account_key=ME, credentials=Credentials(shape=AuthShape.SECRETS, values=values))


def _message(message_id: str, body: str, *, chat: str = CHAT, **extra) -> dict:
    return {"id": message_id, "timestamp": 1789000000, "from": chat, "fromMe": False, "to": f"{ME}@c.us", "body": body, "hasMedia": False, **extra}


def _delivery(payload: dict, *, event: str = "message", session: str = SESSION) -> dict:
    return {"id": "evt_1", "timestamp": 1789000000123, "event": event, "session": session, "me": {"id": f"{ME}@c.us"}, "payload": payload, "engine": "NOWEB"}


def _items(delivery: dict):
    return [
        envelope_of(e.item, data_source_id="ds-waha", provider="waha", segment_key=waha.MESSAGES_SEGMENT)
        for e in WahaSource(_binding()).events_from_webhook(delivery)
    ]


# ── the translation ──────────────────────────────────────────────────────────


def test_a_message_becomes_a_record_in_its_chat_from_a_phone_number():
    (item,) = _items(_delivery(_message("true_x_AAA", "hello", _data={"notifyName": "Dana"})))
    assert (item.external_id, item.body, item.thread_key) == ("true_x_AAA", "hello", CHAT)
    assert (item.author_external_id, item.author_display) == (PHONE, "Dana")


def test_a_lid_sender_keeps_its_opaque_id_so_a_reply_can_reach_it():
    (item,) = _items(_delivery(_message("true_x_LID", "hi", chat=LID)))
    assert (item.thread_key, item.author_external_id) == (LID, LID)


def test_a_lid_sender_with_its_phone_beside_it_matches_a_phone_allowlist():
    data = {"notifyName": "Dana", "key": {"remoteJid": LID, "remoteJidAlt": f"{PHONE}@s.whatsapp.net", "fromMe": False}}
    (item,) = _items(_delivery(_message("true_x_LID2", "hi", chat=LID, _data=data)))
    # The sender is the phone number; the conversation — where the reply goes — stays the raw lid.
    assert (item.author_external_id, item.thread_key) == (PHONE, LID)


def test_nothing_but_another_persons_words_becomes_a_record():
    assert _items(_delivery(_message("m1", "mine", fromMe=True))) == []
    assert _items(_delivery(_message("m2", "in a group", chat="1203630@g.us"))) == []
    assert _items(_delivery(_message("m3", "", hasMedia=True))) == []
    assert _items(_delivery(_message("m4", "ack"), event="message.ack")) == []
    assert _items({"event": "message", "payload": "not a dict"}) == [] and _items({}) == []


def test_a_quote_is_provenance_not_membership():
    (item,) = _items(_delivery(_message("m5", "about that", replyTo={"id": "true_x_AAA", "body": "hello"})))
    assert (item.reply_to_external_id, item.thread_key) == ("true_x_AAA", CHAT)


def test_an_address_is_kept_raw_and_a_bare_number_gains_its_server():
    assert (waha.chat_id("+972-50-123 4567"), waha.chat_id(LID), waha.chat_id("")) == (CHAT, LID, "")
    assert (waha.sender_key(CHAT), waha.sender_key(LID)) == (PHONE, LID)


def test_a_delivery_is_authentic_only_under_the_sessions_key():
    body, creds = b'{"event":"message"}', Credentials(shape=AuthShape.SECRETS, values={"webhook_hmac": SecretStr(HMAC_KEY)})
    assert WahaSource.webhook_authentic({"x-webhook-hmac": sign(body)}, body, creds) is True
    assert WahaSource.webhook_authentic({"x-webhook-hmac": sign(body, "guess")}, body, creds) is False
    assert WahaSource.webhook_authentic({}, body, creds) is False
    assert WahaSource.webhook_authentic({"x-webhook-hmac": sign(body)}, body, Credentials()) is False


# ── the contract, over a WAHA double ─────────────────────────────────────────


class _Waha:
    """Answers the session and sendText routes the way WAHA does; records what it was asked."""

    def __init__(self, *, status: str = "WORKING", exists: bool = True, hooks: list | None = None, noweb: bool = False) -> None:
        self.status, self.exists, self.sent, self.noweb = status, exists, 0, noweb
        self.hooks = [{"url": HOOK, "events": ["message"]}] if hooks is None else hooks
        self.calls: list[tuple[str, str, dict]] = []

    def __call__(self, path, headers):
        method = str(headers.get("_method") or "GET")
        body = json.loads(headers.get("_body") or "{}") if method != "GET" else {}
        self.calls.append((method, path.split("?")[0], body))
        if headers.get("X-Api-Key") != API_KEY:
            return self._json(401, {"message": "Unauthorized"})
        if path.startswith("/api/sendText"):
            self.sent += 1
            if self.noweb:  # the NOWEB engine answers only the message key
                jid = str(body.get("chatId")).replace("@c.us", "@s.whatsapp.net")
                return self._json(201, {"key": {"remoteJid": jid, "fromMe": True, "id": f"OUT{self.sent}"}, "status": "PENDING"})
            return self._json(201, {"id": {"_serialized": f"true_{body.get('chatId')}_OUT{self.sent}"}})
        if method == "POST" and path == "/api/sessions":
            self.exists, self.hooks, self.status = True, body["config"]["webhooks"], "SCAN_QR_CODE"
            return self._json(201, self._session())
        if method == "PUT" and path == f"/api/sessions/{SESSION}":
            self.hooks = body["config"]["webhooks"]
            return self._json(200, self._session())
        if path == f"/api/sessions/{SESSION}":
            return self._json(200, self._session()) if self.exists else self._json(404, {"message": "Session not found"})
        return self._json(404, {"message": "no route"})

    def _session(self) -> dict:
        me = {"id": f"{ME}@c.us", "pushName": "Bot"} if self.status == "WORKING" else None
        return {"name": SESSION, "status": self.status, "config": {"webhooks": self.hooks}, "me": me}

    @staticmethod
    def _json(status: int, reply: dict):
        return status, json.dumps(reply).encode(), {"Content-Type": "application/json"}


@pytest.fixture
def serve(request):
    def _factory(**kwargs):
        double = _Waha(**kwargs)
        server = local_http_server(double)
        base = server.__enter__()
        request.addfinalizer(lambda: server.__exit__(None, None, None))
        return double, base

    return _factory


@pytest.mark.parametrize("check", checks_for(WahaSource), ids=str)
async def test_conformance(check, serve):
    _, base = serve()
    probe = WahaSource(_binding(base))
    await check.run(Subject(
        source=lambda: WahaSource(_binding(base)),
        conversation=probe.conversation_origin(CHAT),
        recipient=UserProfile(origin=probe.conversation_origin("15551230000"), name="Ada"),
    ))


@pytest.fixture
def recorded(monkeypatch):
    seen: list = []

    async def _ingest(items, **_kw):
        seen.extend(items)

    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", _ingest)
    return seen


# ── send ─────────────────────────────────────────────────────────────────────


def _sent(double: _Waha) -> list[dict]:
    return [body for method, path, body in double.calls if (method, path) == ("POST", "/api/sendText")]


async def test_a_reply_goes_to_the_raw_chat_and_quotes_the_message_it_answers(serve, recorded):
    double, base = serve()
    outcome = await driver_type("waha").send(_source(base), thread_key=LID, to=LID, text="hi", in_reply_to="true_x_AAA")
    (body,) = _sent(double)
    assert (body["chatId"], body["reply_to"], body["session"]) == (LID, "true_x_AAA", SESSION)
    assert outcome.external_id == f"true_{LID}_OUT1"


async def test_the_noweb_engine_answer_still_names_the_sent_message(serve, recorded):
    double, base = serve(noweb=True)
    outcome = await driver_type("waha").send(_source(base), thread_key=CHAT, to=CHAT, text="hi")
    assert len(_sent(double)) == 1
    assert outcome.external_id == f"true_{CHAT.replace('@c.us', '@s.whatsapp.net')}_OUT1"


async def test_a_bare_number_is_sent_to_its_phone_chat(serve, recorded):
    double, base = serve()
    await driver_type("waha").send(_source(base), thread_key="", to="+972 50 123 4567", text="hello")
    (body,) = _sent(double)
    assert body["chatId"] == CHAT and "reply_to" not in body


# ── verify ───────────────────────────────────────────────────────────────────


async def test_a_new_source_creates_its_session_with_the_signed_webhook_and_asks_for_the_qr(serve):
    double, base = serve(exists=False)
    verdict = await driver_type("waha").verify(_source(base))
    assert verdict.ready is False and "scan the QR" in verdict.detail and f"/api/{SESSION}/auth/qr" in verdict.detail
    (created,) = [body for method, path, body in double.calls if (method, path) == ("POST", "/api/sessions")]
    assert created["config"]["webhooks"] == [{"url": HOOK, "events": ["message"], "hmac": {"key": HMAC_KEY}}]


async def test_a_session_pointed_elsewhere_is_repointed_at_this_instance(serve):
    double, base = serve(hooks=[{"url": "http://somewhere-else/hook", "events": ["message.any"]}])
    await driver_type("waha").verify(_source(base))
    assert any(method == "PUT" for method, _, _ in double.calls)
    assert double.hooks == [{"url": HOOK, "events": ["message"], "hmac": {"key": HMAC_KEY}}]


async def test_a_paired_session_is_ready_and_stamps_the_number(serve):
    _, base = serve()
    source = _source(base)
    verdict = await driver_type("waha").verify(source)
    assert verdict.ready is True and ME in verdict.detail
    assert source.account_key == ME and ME in source.account_identities


async def test_a_wrong_api_key_says_which_key(serve):
    _, base = serve()
    verdict = await driver_type("waha").verify(_source(base, api_key="wrong"))
    assert verdict.ready is False and "WAHA_API_KEY" in verdict.detail


async def test_a_source_with_no_api_key_asks_for_the_credential():
    source = _source()
    source.config = {k: v for k, v in source.config.items() if k != "api_key"}
    verdict = await driver_type("waha").verify(source)
    assert verdict.ready is False and "`waha` credential" in verdict.detail


# ── the webhook route ────────────────────────────────────────────────────────


class _Request:
    """Signed by WAHA's rule unless ``headers`` says otherwise."""

    def __init__(self, body: dict, headers: dict | None = None):
        self.query_params = {}
        self._raw = json.dumps(body).encode()
        self.headers = {"x-webhook-hmac": sign(self._raw)} if headers is None else headers

    async def body(self):
        return self._raw


async def test_a_signed_delivery_reaches_the_ingestor_and_an_unsigned_one_is_refused(recorded):
    from flow_sdk.server.routes.data_source_webhook import webhook_delivery

    session = "route-session-1"
    source = _source(session=session)
    await source.save()
    delivery = _delivery(_message("true_x_ROUTE", "hello there"), session=session)

    forged = await webhook_delivery("waha", _Request(delivery, headers={"x-webhook-hmac": sign(json.dumps(delivery).encode(), "guess")}))
    assert forged.status_code == 401 and recorded == []

    response = await webhook_delivery("waha", _Request(delivery))
    assert response.data["ingested"] == 1
    assert [i.external_id for i in recorded] == ["true_x_ROUTE"] and recorded[0].data_source_id == source.id


async def test_a_delivery_for_an_unknown_session_answers_200():
    from flow_sdk.server.routes.data_source_webhook import webhook_delivery

    response = await webhook_delivery("waha", _Request(_delivery(_message("m", "hi"), session="nobody-here")))
    assert response.data["ingested"] == 0 and "no source" in response.data["reason"]
