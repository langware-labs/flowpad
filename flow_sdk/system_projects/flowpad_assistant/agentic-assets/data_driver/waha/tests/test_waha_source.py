"""The ``waha`` data source: WAHA's webhook translation, the session it keeps, and the send leg.

The translation is a pure method, so those tests need no socket; verify and send talk HTTP to a
loopback WAHA double that answers the session and ``sendText`` routes.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import uuid

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.legacy_lift import envelope_of
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.errors import NotFound
from flow_sdk.sources.files import local_file
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import FileItem, FileKind, MessageData, MessageFileData, ReactionItem, ReactionMode

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
EVENTS = ["message", "message.reaction"]
#: Where WAHA says its files are — its OWN host, which this machine does not reach.
WAHA_OWN_HOST = "http://localhost:3000"


def sign(body: bytes, key: str = HMAC_KEY) -> str:
    """WAHA's ``X-Webhook-Hmac`` for a raw delivery body."""
    return hmac.new(key.encode(), body, hashlib.sha512).hexdigest()


def _config(**extra) -> dict:
    return {"session": SESSION, **extra}


#: The ``waha`` credential's values — never config: the keys (WAHA_API_KEY, WAHA_WEBHOOK_HMAC) and, per
#: machine, where the container answers and how it reaches this instance (WAHA_BASE_URL,
#: WAHA_WEBHOOK_URL). A test that wants a wrong or missing one changes this dict.
SECRETS = {"api_key": API_KEY, "webhook_hmac": HMAC_KEY, "base_url": "http://127.0.0.1:9", "webhook_url": HOOK}


@pytest.fixture(autouse=True)
def _credential(monkeypatch):
    saved = dict(SECRETS)

    async def resolve(_row):
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={k: SecretStr(v) for k, v in SECRETS.items() if v})

    monkeypatch.setattr(DataDriver.loaded("waha"), "credentials_for", resolve)
    yield
    SECRETS.clear()
    SECRETS.update(saved)


def _source(base: str = "http://127.0.0.1:9", **extra) -> DataSource:
    SECRETS["base_url"] = base  # this machine's WAHA — a credential value, resolved per placement
    return DataSource(provider="waha", name=f"WAHA test {uuid.uuid4().hex[:8]}", config=_config(**extra))


def _binding(base: str = "http://127.0.0.1:9") -> SourceBinding:
    values = {k: SecretStr(v) for k, v in {**SECRETS, "base_url": base}.items()}
    return SourceBinding(config=_config(), account_key=ME, credentials=ResolvedSecrets(shape=AuthShape.SECRETS, values=values))


def _message(message_id: str, body: str, *, chat: str = CHAT, **extra) -> dict:
    return {"id": message_id, "timestamp": 1789000000, "from": chat, "fromMe": False, "to": f"{ME}@c.us", "body": body, "hasMedia": False, **extra}


def _delivery(payload: dict, *, event: str = "message", session: str = SESSION) -> dict:
    return {"id": "evt_1", "timestamp": 1789000000123, "event": event, "session": session, "me": {"id": f"{ME}@c.us"}, "payload": payload, "engine": "NOWEB"}


def _items(delivery: dict):
    return [
        envelope_of(e.item, data_source_id="ds-waha", provider="waha")
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
    assert _items(_delivery(_message("m3", ""))) == []
    assert _items(_delivery(_message("m4", "ack"), event="message.ack")) == []
    assert _items({"event": "message", "payload": "not a dict"}) == [] and _items({}) == []


def _events(delivery: dict):
    return [e.item for e in WahaSource(_binding()).events_from_webhook(delivery)]


def _media(message_id: str, mimetype: str, *, body: str = "", url: str | None = "default", filename=None, error=None, _data=None, **extra) -> dict:
    link = f"{WAHA_OWN_HOST}/api/files/{SESSION}/{message_id}.bin" if url == "default" else url
    media = {"url": link, "mimetype": mimetype, "filename": filename, "error": error}
    return _message(message_id, body, hasMedia=True, media=media, **({"_data": _data} if _data else {}), **extra)


@pytest.mark.parametrize(("mimetype", "data", "kind"), [
    ("image/jpeg", None, FileKind.IMAGE),
    ("video/mp4", {"type": "video"}, FileKind.VIDEO),
    ("audio/mpeg", {"type": "audio"}, FileKind.AUDIO),
    ("audio/ogg; codecs=opus", {"type": "ptt"}, FileKind.VOICE),
    ("audio/ogg; codecs=opus", {"message": {"audioMessage": {"ptt": True}}}, FileKind.VOICE),
    ("image/png", {"type": "document"}, FileKind.DOCUMENT),
    ("image/webp", {"message": {"stickerMessage": {}}}, FileKind.STICKER),
])
def test_an_inbound_media_message_carries_its_file_by_the_path_waha_serves_it_at(mimetype, data, kind):
    (item,) = _events(_delivery(_media("false_x_M1", mimetype, body="look", filename="f.bin", _data=data)))
    (f,) = item.data.attachments
    probe = WahaSource(_binding())
    assert item.data.text is None and item.origin == probe.message_origin("false_x_M1", CHAT)
    assert f.origin == probe.media_origin(f"/api/files/{SESSION}/false_x_M1.bin")  # WAHA's host is gone
    assert (f.data.as_, f.data.media_type, f.data.caption, f.data.name, f.data.fetch_error) == (kind, mimetype, "look", "f.bin", None)


def test_media_waha_did_not_download_is_kept_with_why():
    (item,) = _events(_delivery(_media("false_x_BIG", "video/mp4", url=None, error="file too large")))
    (f,) = item.data.attachments
    assert f.origin.key == "false_x_BIG:media" and "file too large" in f.data.fetch_error


def test_an_inbound_reaction_names_the_message_as_it_is_keyed_and_empty_takes_it_back():
    target = f"true_{CHAT}_OUT1"
    on = {"id": "false_x_R1", "from": CHAT, "fromMe": False, "timestamp": 1789000001, "reaction": {"text": "👍", "messageId": target}}
    off = {**on, "id": "false_x_R2", "reaction": {"text": "", "messageId": target}}
    mine = {**on, "id": "true_x_R3", "fromMe": True}
    (added,) = _events(_delivery(on, event="message.reaction"))
    (removed,) = _events(_delivery(off, event="message.reaction"))
    probe = WahaSource(_binding())
    assert isinstance(added, ReactionItem) and added.data.target == probe.message_origin(target, CHAT)
    assert (added.data.emojis, added.data.mode, added.data.sender.origin.key) == (("👍",), ReactionMode.SET, PHONE)
    assert removed.data.emojis == () and _events(_delivery(mine, event="message.reaction")) == []


def test_a_quote_is_provenance_not_membership():
    (item,) = _items(_delivery(_message("m5", "about that", replyTo={"id": "true_x_AAA", "body": "hello"})))
    assert (item.reply_to_external_id, item.thread_key) == ("true_x_AAA", CHAT)


def test_an_address_is_kept_raw_and_a_bare_number_gains_its_server():
    assert (waha.chat_id("+972-50-123 4567"), waha.chat_id(LID), waha.chat_id("")) == (CHAT, LID, "")
    assert (waha.sender_key(CHAT), waha.sender_key(LID)) == (PHONE, LID)


def test_a_delivery_is_authentic_only_under_the_sessions_key():
    body, creds = b'{"event":"message"}', ResolvedSecrets(shape=AuthShape.SECRETS, values={"webhook_hmac": SecretStr(HMAC_KEY)})
    assert WahaSource.webhook_authentic({"x-webhook-hmac": sign(body)}, body, creds) is True
    assert WahaSource.webhook_authentic({"x-webhook-hmac": sign(body, "guess")}, body, creds) is False
    assert WahaSource.webhook_authentic({}, body, creds) is False
    assert WahaSource.webhook_authentic({"x-webhook-hmac": sign(body)}, body, ResolvedSecrets()) is False


# ── the contract, over a WAHA double ─────────────────────────────────────────


class _Waha:
    """Answers the session and sendText routes the way WAHA does; records what it was asked."""

    def __init__(self, *, status: str = "WORKING", exists: bool = True, hooks: list | None = None, noweb: bool = False) -> None:
        self.status, self.exists, self.sent, self.noweb = status, exists, 0, noweb
        self.hooks = [{"url": HOOK, "events": list(EVENTS)}] if hooks is None else hooks
        self.calls: list[tuple[str, str, dict]] = []
        #: What WAHA serves under ``/api/files/...``, by path: ``(bytes, mimetype)``.
        self.files: dict[str, tuple[bytes, str]] = {}

    def __call__(self, path, headers):
        method = str(headers.get("_method") or "GET")
        body = json.loads(headers.get("_body") or "{}") if method != "GET" else {}
        self.calls.append((method, path.split("?")[0], body))
        if headers.get("X-Api-Key") != API_KEY:
            return self._json(401, {"message": "Unauthorized"})
        if path.startswith("/api/files/"):
            held = self.files.get(path)
            return (200, held[0], {"Content-Type": held[1]}) if held else self._json(404, {"message": "file not found"})
        if (method, path) == ("PUT", "/api/reaction"):
            return self._json(200, {})
        if path.startswith(("/api/sendText", "/api/sendImage", "/api/sendVideo", "/api/sendVoice", "/api/sendFile")):
            self.sent += 1
            if self.noweb:  # the NOWEB engine answers only the message key
                jid = str(body.get("chatId")).replace("@c.us", "@s.whatsapp.net")
                return self._json(201, {"key": {"remoteJid": jid, "fromMe": True, "id": f"OUT{self.sent}"}, "status": "PENDING"})
            return self._json(201, {"id": {"_serialized": f"true_{body.get('chatId')}_OUT{self.sent}"}})
        if method == "POST" and path == "/api/sessions":
            self.exists, self.hooks, self.status = True, body["config"]["webhooks"], "SCAN_QR_CODE"
            return self._json(201, self._session())
        # Any session's own routes: a caller names its session (the Double's is this run's own).
        named = path.split("?")[0].startswith("/api/sessions/")
        if method == "PUT" and named:
            self.hooks = body["config"]["webhooks"]
            return self._json(200, self._session())
        if named:
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
    double, base = serve()
    double.files["/api/files/default/conf.jpg"] = (b"\xff\xd8 conformance", "image/jpeg")
    probe = WahaSource(_binding(base))
    await check.run(Subject(
        source=lambda: WahaSource(_binding(base)),
        conversation=probe.conversation_origin(CHAT),
        recipient=UserProfile(origin=probe.conversation_origin("15551230000"), name="Ada"),
        inbound_file=FileItem(origin=probe.media_origin("/api/files/default/conf.jpg"), data=MessageFileData(as_=FileKind.IMAGE)),
        inbound_bytes=b"\xff\xd8 conformance",
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
    outcome = await DataDriver.loaded("waha").send(_source(base), thread_key=LID, to=LID, text="hi", in_reply_to="true_x_AAA")
    (body,) = _sent(double)
    assert (body["chatId"], body["reply_to"], body["session"]) == (LID, "true_x_AAA", SESSION)
    assert outcome.external_id == f"true_{LID}_OUT1"


async def test_the_noweb_engine_answer_still_names_the_sent_message(serve, recorded):
    double, base = serve(noweb=True)
    outcome = await DataDriver.loaded("waha").send(_source(base), thread_key=CHAT, to=CHAT, text="hi")
    assert len(_sent(double)) == 1
    assert outcome.external_id == f"true_{CHAT.replace('@c.us', '@s.whatsapp.net')}_OUT1"


async def test_a_bare_number_is_sent_to_its_phone_chat(serve, recorded):
    double, base = serve()
    await DataDriver.loaded("waha").send(_source(base), thread_key="", to="+972 50 123 4567", text="hello")
    (body,) = _sent(double)
    assert body["chatId"] == CHAT and "reply_to" not in body


# ── files ────────────────────────────────────────────────────────────────────


def _file(tmp_path, name: str, content: bytes, **kw) -> FileItem:
    path = tmp_path / name
    path.write_bytes(content)
    return local_file(path, **kw)


@pytest.mark.parametrize(("name", "as_", "route"), [
    ("photo.png", "image", "/api/sendImage"),
    ("clip.mp4", "video", "/api/sendVideo"),
    ("note.ogg", "voice", "/api/sendVoice"),
    ("song.mp3", "audio", "/api/sendFile"),
    ("report.pdf", "document", "/api/sendFile"),
    ("sticker.webp", "sticker", "/api/sendFile"),
])
async def test_each_kind_goes_to_its_route_with_the_bytes_inline(serve, tmp_path, name, as_, route):
    double, base = serve()
    content = b"\x00\x01bytes of " + name.encode() + b"\xff"
    item = _file(tmp_path, name, content, as_=as_)
    async with WahaSource(_binding(base)) as source:
        sent = await source.send(MessageData(conversation=source.conversation_origin(CHAT), attachments=(item,)))
    ((method, path, body),) = [c for c in double.calls if c[1].startswith("/api/send")]
    assert (method, path, body["chatId"], body["session"]) == ("POST", route, CHAT, SESSION)
    assert base64.b64decode(body["file"]["data"]) == content  # byte-exact
    assert (body["file"]["mimetype"], body["file"]["filename"]) == (item.data.media_type, name)
    assert body.get("convert") is (True if as_ in ("voice", "video") else None) and "caption" not in body and "text" not in body
    assert sent.data.attachments == (item,) and sent.origin.key == f"true_{CHAT}_OUT1"


async def test_the_body_rides_as_the_caption_and_a_reply_still_quotes(serve, recorded, tmp_path, monkeypatch):
    double, base = serve()
    monkeypatch.setattr(DataDriver.loaded("waha"), "files_root", lambda row: tmp_path / "kept")
    photo = tmp_path / "photo.jpg"
    photo.write_bytes(b"jpeg!")
    await DataDriver.loaded("waha").send(_source(base), thread_key=CHAT, to=CHAT, text="the view", in_reply_to="false_x_AAA", files=[local_file(photo)])
    ((_, path, body),) = [c for c in double.calls if c[1].startswith("/api/send")]
    assert (path, body["caption"], body["reply_to"]) == ("/api/sendImage", "the view", "false_x_AAA")


async def test_a_file_that_is_not_local_or_a_captioned_sticker_is_refused(serve, tmp_path):
    double, base = serve()
    foreign = FileItem(origin=WahaSource(_binding(base)).media_origin("/api/files/x.jpg"), data=MessageFileData(path="/etc/hosts"))
    async with WahaSource(_binding(base)) as source:
        to = source.conversation_origin(CHAT)
        with pytest.raises(ValueError, match="local file"):
            await source.send(MessageData(conversation=to, attachments=(foreign,)))
        with pytest.raises(ValueError, match="no caption"):
            await source.send(MessageData(text="words", conversation=to, attachments=(_file(tmp_path, "s.webp", b"s", as_="sticker"),)))
    assert double.calls == []


async def test_open_reads_the_file_from_this_machines_waha_not_the_host_waha_reported(serve):
    double, base = serve()
    double.files["/api/files/default/false_x_M1.bin"] = (b"B" * 70_000 + b"end", "image/jpeg")
    (item,) = [e.item for e in WahaSource(_binding(base)).events_from_webhook(_delivery(_media("false_x_M1", "image/jpeg")))]
    async with WahaSource(_binding(base)) as source:
        got = b""
        async with source.open(item.data.attachments[0]) as chunks:
            async for chunk in chunks:
                got += chunk
    assert got == b"B" * 70_000 + b"end"
    assert double.calls[-1][:2] == ("GET", "/api/files/default/false_x_M1.bin")


async def test_a_file_waha_no_longer_holds_is_not_found_and_staging_says_why(serve, tmp_path, monkeypatch):
    _, base = serve()
    driver = DataDriver.loaded("waha")
    monkeypatch.setattr(driver, "files_root", lambda row: tmp_path)
    async with WahaSource(_binding(base)) as source:
        gone = source.media_origin("/api/files/default/gone.jpg")
        with pytest.raises(NotFound):
            async with source.open(FileItem(origin=gone, data=MessageFileData())):
                pass
        events = await driver._stage_events(_source(base), source, source.events_from_webhook(_delivery(_media("false_x_GONE", "image/jpeg"))))
    (f,) = events[0].item.data.attachments
    assert f.data.path is None and "HTTP 404" in f.data.fetch_error


# ── reactions ────────────────────────────────────────────────────────────────


async def test_react_and_unreact_put_the_reaction_on_the_message(serve):
    double, base = serve()
    async with WahaSource(_binding(base)) as source:
        target = source.message_origin("false_x_AAA", CHAT)
        await source.react(target, "👍")
        await source.unreact(target)
        with pytest.raises(ValueError, match="emoji"):
            await source.react(target, "")
    assert [(m, p, b) for m, p, b in double.calls] == [
        ("PUT", "/api/reaction", {"session": SESSION, "messageId": "false_x_AAA", "reaction": "👍"}),
        ("PUT", "/api/reaction", {"session": SESSION, "messageId": "false_x_AAA", "reaction": ""}),
    ]


# ── verify ───────────────────────────────────────────────────────────────────


async def test_a_new_source_creates_its_session_with_the_signed_webhook_and_asks_for_the_qr(serve):
    double, base = serve(exists=False)
    verdict = await DataDriver.loaded("waha").verify(_source(base))
    assert verdict.ready is False and "scan the QR" in verdict.detail and f"/api/{SESSION}/auth/qr" in verdict.detail
    (created,) = [body for method, path, body in double.calls if (method, path) == ("POST", "/api/sessions")]
    assert created["config"]["webhooks"] == [{"url": HOOK, "events": EVENTS, "hmac": {"key": HMAC_KEY}}]


async def test_a_session_pointed_elsewhere_is_repointed_at_this_instance(serve):
    double, base = serve(hooks=[{"url": "http://somewhere-else/hook", "events": ["message.any"]}])
    await DataDriver.loaded("waha").verify(_source(base))
    assert any(method == "PUT" for method, _, _ in double.calls)
    assert double.hooks == [{"url": HOOK, "events": EVENTS, "hmac": {"key": HMAC_KEY}}]


async def test_a_session_calling_here_for_fewer_events_is_resubscribed(serve):
    double, base = serve(hooks=[{"url": HOOK, "events": ["message"]}])
    await DataDriver.loaded("waha").verify(_source(base))
    assert double.hooks == [{"url": HOOK, "events": EVENTS, "hmac": {"key": HMAC_KEY}}]


async def test_a_session_already_subscribed_here_is_left_alone(serve):
    double, base = serve()
    await DataDriver.loaded("waha").verify(_source(base))
    assert not any(method == "PUT" for method, _, _ in double.calls)


async def test_a_paired_session_is_ready_and_stamps_the_number(serve):
    _, base = serve()
    source = _source(base)
    verdict = await DataDriver.loaded("waha").verify(source)
    assert verdict.ready is True and ME in verdict.detail
    assert source.account_key == ME and ME in source.account_identities


async def test_a_wrong_api_key_says_which_key(serve):
    _, base = serve()
    SECRETS["api_key"] = "wrong"
    verdict = await DataDriver.loaded("waha").verify(_source(base))
    assert verdict.ready is False and "WAHA_API_KEY" in verdict.detail


async def test_a_source_with_no_api_key_asks_for_the_credential():
    source = _source()
    SECRETS.pop("api_key")
    verdict = await DataDriver.loaded("waha").verify(source)
    assert verdict.ready is False and "`waha` credential" in verdict.detail


async def test_where_waha_answers_is_this_machines_credential_value_not_config(serve):
    """``data_source.json`` travels with the repo; a URL that differs per machine is ``WAHA_BASE_URL`` /
    ``WAHA_WEBHOOK_URL``, resolved where the source runs — the config names neither."""
    double, base = serve(exists=False)
    source = _source(base)
    SECRETS["webhook_url"] = "https://hub.example/webhook/deployment/abc"

    await DataDriver.loaded("waha").verify(source)

    assert "base_url" not in source.config and "webhook_url" not in source.config
    (created,) = [body for method, path, body in double.calls if (method, path) == ("POST", "/api/sessions")]
    assert created["config"]["webhooks"][0]["url"] == "https://hub.example/webhook/deployment/abc"


@pytest.mark.parametrize(("missing", "named"), [("base_url", "WAHA_BASE_URL"), ("webhook_url", "WAHA_WEBHOOK_URL")])
async def test_a_machine_without_its_waha_urls_is_told_which_variable_to_set(serve, missing, named):
    _, base = serve(exists=False)
    source = _source(base)
    SECRETS.pop(missing)

    verdict = await DataDriver.loaded("waha").verify(source)

    assert verdict.ready is False and named in verdict.detail


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


async def test_teardown_removes_only_this_instances_webhook_and_leaves_the_session(serve):
    """A deployment's machine is going: WAHA stops calling it. The session, its pairing and a webhook some
    other instance registered stay."""
    other = {"url": "http://another-instance/hook", "events": ["message"]}
    double, base = serve(hooks=[{"url": HOOK, "events": ["message"]}, other])
    async with WahaSource(_binding(base)) as live:
        report = await live.teardown()
        again = await live.teardown()

    assert double.hooks == [other] and "removed" in report
    assert again == "", "nothing of its own left: nothing written"
    assert not any(method in ("DELETE", "POST") for method, _, _ in double.calls), "the session is never stopped or recreated"


# ── the Double ───────────────────────────────────────────────────────────────


async def test_the_double_carries_files_quotes_and_reactions_both_ways(monkeypatch, tmp_path):
    from flow_sdk.builtin.source_item import SourceItem
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, load_module
    from flow_sdk.sources.values.origin import CloudOrigin

    Double = load_module(SHIPPED_ROOT / "waha" / "tests", "matrix").Double  # as the matrix runner loads it
    driver = DataDriver.loaded("waha")
    monkeypatch.setattr(driver, "files_root", lambda row: tmp_path / "files")
    with Double() as double:
        monkeypatch.setattr(driver, "credentials_for", double.credentials)
        source = DataSource(provider="waha", name=f"WAHA double {uuid.uuid4().hex[:8]}", config=double.config)
        await source.save()

        async def push(delivery):
            return await driver.ingest_pushed(source, json.loads(delivery["body"]), headers=delivery["headers"], raw=delivery["body"])

        first = double.deliver("hi", sender=PHONE)
        await push(first)
        delivery = double.deliver("a picture", sender=PHONE, reply_to=first["external_id"],
                                  files=[{"name": "p.jpg", "media_type": "image/jpeg", "as_": "image", "bytes": b"jpeg bytes"}])
        assert (await push(delivery))["ingested"] == 1
        (row,) = await SourceItem.get_all({"data_source_id": source.id, "origin_key": delivery["external_id"]})
        assert row.reply_to_external_id == first["external_id"]

        assert (await push(double.react(first["external_id"], "❤️", sender=PHONE)))["reactions"] == 1
        (reacted,) = await SourceItem.get_all({"data_source_id": source.id, "origin_key": first["external_id"]})
        assert [r.emoji for r in reacted.reactions] == ["❤️"]  # landed on the message it named
        await driver.react(source, CloudOrigin(kind=reacted.origin_kind, namespace=reacted.origin_namespace, key=reacted.origin_key), "👍")
        assert double.reactions() == [{"target": first["external_id"], "emoji": "👍"}]

        # A send stamps the number it went out as (`account_key`), which scopes every later origin — so last.
        note = tmp_path / "note.ogg"
        note.write_bytes(b"OggS voice")
        await driver.send(source, thread_key=CHAT, to=CHAT, text="", in_reply_to=delivery["external_id"], files=[local_file(note, as_="voice")])
        (sent,) = double.sent()
        assert sent["reply_to"] == delivery["external_id"]
        assert sent["files"] == [{"as_": "voice", "name": "note.ogg", "media_type": "audio/ogg", "caption": None, "bytes": b"OggS voice"}]
