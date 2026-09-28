"""The ``telegram`` data source against a real-socket Bot API double.

Pins the three facts the source is built around: the offset-acknowledged queue (the committed
cursor IS the ack), per-chat message ids (the key carries the chat), and the missing echo (a
bot never receives its own messages, so the sent copy is recorded from the send). Plus the
outbound spec's chat-targeted reply, and a token that never reaches an error message.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timezone
from email.parser import BytesParser
from email.policy import default as email_policy
from types import SimpleNamespace
from urllib.parse import parse_qs

import pytest
from pydantic import SecretStr, ValidationError

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.source_item import TelegramMessageSpec
from flow_sdk.ingest.driver_registry import SHIPPED_ROOT, asset_module, load_module
from flow_sdk.ingest.driver_runtime import SendStatus
from flow_sdk.ingest.testing import local_http_server, position
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.errors import Rejected, Unsupported
from flow_sdk.sources.files import local_file
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import FileItem, FileKind, MessageFileData, ReactionData, ReactionMode

MAX_TEXT_LEN = asset_module("telegram").MAX_TEXT_LEN
TelegramSource = asset_module("telegram").TelegramSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

TOKEN = "123:TEST"
CHAT = "111222333"
MESSAGE = {
    "message_id": 7,
    "date": 1756700000,
    "chat": {"id": 111222333, "type": "private", "first_name": "Eran"},
    "from": {"id": 444555666, "username": "eran", "first_name": "Eran"},
    "text": "hello bot",
}


#: The upload field each send method takes, and what the message it answers carries.
MEDIA_METHODS = {"sendPhoto": "photo", "sendVideo": "video", "sendAudio": "audio", "sendVoice": "voice",
                 "sendDocument": "document", "sendSticker": "sticker"}


def multipart(headers) -> tuple[dict, dict]:
    """A multipart body as ``(fields, files)``; a file is ``(filename, content_type, bytes)``."""
    raw = headers["_raw"]
    message = BytesParser(policy=email_policy).parsebytes(b"Content-Type: " + headers["Content-Type"].encode() + b"\r\n\r\n" + raw)
    fields, files = {}, {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        payload = part.get_payload(decode=True)
        if part.get_filename() is not None:
            files[name] = (part.get_filename(), part.get_content_type(), payload)
        else:
            fields[name] = payload.decode()
    return fields, files


class _Bot:
    """A Bot API: a queue of updates, chats it can post into, files it holds, and every request it
    was asked."""

    def __init__(self, updates=None):
        self.updates = list(updates or [])
        self.chats = {CHAT, "-100123", "444555666"}
        self.requests, self.bodies, self.next_id = [], [], 8
        #: file_id → (bytes, file_path, reported size); an upload lands here and getFile serves it.
        self.files: dict[str, tuple[bytes, str, int]] = {}
        #: Every multipart upload: (method, fields, files).
        self.uploads: list = []
        # The loopback server answers on its own thread while a test delivers on another: an id is
        # handed out under a lock, as the real Bot API never hands out one twice.
        self._ids = threading.Lock()

    def mint_id(self) -> int:
        with self._ids:
            minted, self.next_id = self.next_id, self.next_id + 1
        return minted

    def hold(self, data: bytes, *, size=None, ext="bin") -> dict:
        """A file on Telegram's side; answers its ``File`` fields."""
        n = self.mint_id()
        file_id = f"file-{n}"
        self.files[file_id] = (data, f"docs/file_{n}.{ext}", len(data) if size is None else size)
        return {"file_id": file_id, "file_unique_id": f"uniq-{n}", "file_size": self.files[file_id][2]}

    def __call__(self, path, headers):
        route, _, query = path.partition("?")
        if route.startswith(f"/file/bot{TOKEN}/"):
            stored = route[len(f"/file/bot{TOKEN}/"):]
            for data, file_path, _size in self.files.values():
                if file_path == stored:
                    self.requests.append(("download", {"path": stored}))
                    return 200, data, {"Content-Type": "application/octet-stream"}
            return 404, b"", {}
        method = route.rsplit("/", 1)[-1]
        params = {k: v[0] for k, v in parse_qs(query).items()}
        uploaded: dict = {}
        if str(headers.get("Content-Type") or "").startswith("multipart/"):
            body, uploaded = multipart(headers)
            self.uploads.append((method, body, uploaded))
        else:
            body = json.loads(headers["_body"]) if headers.get("_body") else {}
        self.requests.append((method, params))
        self.bodies.append(body)
        if method == "getMe":
            return self._ok({"id": 777, "username": "my_bot"})
        if method == "getUpdates":
            offset, limit = int(params.get("offset") or 0), int(params.get("limit") or 100)
            return self._ok([u for u in self.updates if u["update_id"] >= offset][:limit])
        if method == "getFile":
            held = self.files.get(params.get("file_id", ""))
            if held is None:
                return self._refuse("Bad Request: invalid file_id")
            if held[2] > 20_000_000:
                return self._refuse("Bad Request: file is too big")
            return self._ok({"file_id": params["file_id"], "file_size": held[2], "file_path": held[1]})
        if str(body.get("chat_id")) not in self.chats:
            return self._refuse("Bad Request: chat not found")
        if method == "setMessageReaction":
            return self._ok(True)
        sent = {"message_id": self.mint_id(), "date": int(time.time()), "chat": {"id": int(body["chat_id"]), "type": "private"},
                "from": {"id": 777, "username": "my_bot", "is_bot": True}}
        if method == "sendMessage":
            sent["text"] = body["text"]
        elif method in MEDIA_METHODS:
            field = MEDIA_METHODS[method]
            name, content_type, data = uploaded[field]
            held = self.hold(data)
            if field == "photo":
                sent["photo"] = [{**held, "width": 90, "height": 90, "file_size": 1}, {**held, "width": 800, "height": 800}]
            else:
                sent[field] = {**held, "file_name": name, "mime_type": content_type}
            if body.get("caption"):
                sent["caption"] = body["caption"]
        else:
            return self._refuse(f"Not Found: method {method}", code=404)
        replying = body.get("reply_parameters")
        if isinstance(replying, str):
            replying = json.loads(replying)
        if replying:
            sent["reply_to_message"] = {"message_id": replying["message_id"]}
        if body.get("message_thread_id"):
            sent["message_thread_id"] = int(body["message_thread_id"])
        return self._ok(sent)

    @staticmethod
    def _refuse(description, code=400):
        return code, json.dumps({"ok": False, "error_code": code, "description": description}).encode(), {}

    @staticmethod
    def _ok(result):
        return 200, json.dumps({"ok": True, "result": result}).encode(), {"Content-Type": "application/json"}


@pytest.fixture(autouse=True)
def _token(monkeypatch):
    """The token is the ``telegram`` credential (TELEGRAM_BOT_TOKEN), never config."""
    async def resolve(_row):
        return ResolvedSecrets(shape=AuthShape.SECRETS, values={"bot_token": SecretStr(TOKEN)})

    monkeypatch.setattr(DataDriver.loaded("telegram"), "credentials_for", resolve)


@pytest.fixture
def bot(request):
    fake = _Bot(getattr(request, "param", None))
    with local_http_server(fake) as base:
        fake.base = base
        yield fake


def _row(bot, **fields):
    return SimpleNamespace(
        id="ds-tg", provider="telegram", name="Telegram bot", config={"base_url": bot.base},
        account_key="@my_bot", account_identities=["777", "@my_bot"], **fields,
    )


def _view(prior=None, *, cursor=None):
    return position(prior, cursor=cursor)


def _update(update_id, **message):
    return {"update_id": update_id, "message": {**MESSAGE, **message}}


@pytest.mark.parametrize("check", checks_for(TelegramSource), ids=str)
async def test_conformance(check, bot):
    held = bot.hold(b"%PDF-1.4 conformance", ext="pdf")
    bot.updates = [_update(900000 + n, message_id=n) for n in (1, 2)]
    bot.updates.append(_update(900003, message_id=3, text=None, caption="the file", document={**held, "file_name": "c.pdf", "mime_type": "application/pdf"}))
    binding = SourceBinding(
        config={"base_url": bot.base}, credentials=ResolvedSecrets(shape=AuthShape.SECRETS, values={"bot_token": SecretStr(TOKEN)})
    )
    probe = TelegramSource(binding)
    await check.run(Subject(
        source=lambda: TelegramSource(binding),
        seeded=tuple(probe.origin(f"{CHAT}/{n}") for n in (1, 2, 3)),
        conversation=probe.chat_origin(CHAT),
        recipient=UserProfile(origin=probe.origin("444555666"), name="Eran"),
        inbound_file=FileItem(origin=probe.origin(held["file_id"], "files"), data=MessageFileData(name="c.pdf", size=held["file_size"])),
        inbound_bytes=b"%PDF-1.4 conformance",
    ))


class TestTheSource:
    def test_it_sends_on_its_own_channel_and_getme_names_the_account(self, bot):
        """No config field names the bot: its token is a credential, its @username comes from getMe."""
        driver = DataDriver.loaded("telegram")
        assert driver.sends is True and driver.identity_config_key == ""
        assert driver.channel_for(_row(bot)) == "telegram"

    async def test_the_queue_takes_no_query_and_refuses_a_narrowing(self, bot):
        source = await DataDriver.loaded("telegram").open(_row(bot))
        assert source.query() is None
        async with source:
            with pytest.raises(ValueError):
                await source.fetch(narrow={"since": "2026-01-01T00:00:00+00:00"})

    async def test_the_token_never_rides_in_config(self, bot):
        source = await DataDriver.loaded("telegram").open(_row(bot))
        assert "bot_token" not in source.config and source.credentials.value("bot_token") == TOKEN


class TestMapping:
    async def _only(self, bot, **message):
        bot.updates = [_update(900001, **message)]
        (item,) = (await DataDriver.loaded("telegram").traverse(_row(bot), _view())).items
        return item

    async def test_the_key_carries_the_chat(self, bot):
        item = await self._only(bot)
        assert (item.external_id, item.thread_key, item.kind) == (f"{CHAT}/7", CHAT, "content.message.chat")

    async def test_a_forum_topic_extends_the_thread(self, bot):
        item = await self._only(bot, chat={"id": -100123, "type": "supergroup", "title": "Team", "is_forum": True}, message_thread_id=42)
        assert (item.thread_key, item.external_id, item.name) == ("-100123/42", "-100123/7", "Team")

    async def test_author_time_and_body_are_normalized(self, bot):
        item = await self._only(bot)
        assert (item.author_external_id, item.author_display, item.body) == ("444555666", "@eran", "hello bot")
        assert item.occurred_at.startswith("2025")

    async def test_a_caption_stands_in_for_text(self, bot):
        assert (await self._only(bot, text=None, caption="a photo")).body == "a photo"

    async def test_a_message_without_identity_is_not_an_item(self, bot):
        bot.updates = [{"update_id": 900001, "message": {"chat": {}, "message_id": None}}]
        assert (await DataDriver.loaded("telegram").traverse(_row(bot), _view())).items == []


class TestTheCursorIsTheAck:
    async def test_the_committed_offset_is_what_is_sent_back(self, bot):
        bot.updates = [_update(900001)]
        result = await DataDriver.loaded("telegram").traverse(_row(bot), _view(cursor=TelegramSource.resume_at(900001)))
        assert bot.requests[-1][1]["offset"] == "900001"
        assert result.cursor == TelegramSource.resume_at(900002)
        assert [i.external_id for i in result.items] == [f"{CHAT}/7"]

    async def test_a_first_run_sends_no_offset(self, bot):
        result = await DataDriver.loaded("telegram").traverse(_row(bot), _view())
        assert "offset" not in bot.requests[-1][1] and result.unchanged is True and result.cursor is None

    async def test_non_message_updates_still_advance_the_offset(self, bot):
        bot.updates = [{"update_id": 900005, "edited_message": {**MESSAGE}}]
        result = await DataDriver.loaded("telegram").traverse(_row(bot), _view(cursor=TelegramSource.resume_at(900001)))
        assert result.items == [] and result.cursor == TelegramSource.resume_at(900006)


class TestSend:
    async def test_a_reply_maps_onto_send_message(self, bot, recorded):
        out = await DataDriver.loaded("telegram").send(_row(bot), thread_key=CHAT, to=CHAT, text="hi", in_reply_to=f"{CHAT}/7")
        assert bot.requests[-1][0] == "sendMessage"
        assert bot.bodies[-1] == {"chat_id": CHAT, "text": "hi", "reply_parameters": {"message_id": 7}}
        assert (out.status, out.external_id) == (SendStatus.SENT, f"{CHAT}/8")

    async def test_the_sent_copy_is_recorded_because_nothing_will_echo_it(self, bot, recorded):
        out = await DataDriver.loaded("telegram").send(_row(bot), thread_key=CHAT, to=CHAT, text="hi")
        assert out.recorded is True
        assert [i.external_id for i in recorded] == [f"{CHAT}/8"]
        assert recorded[0].author_external_id == "777", "the copy's author is the bot"

    async def test_a_forum_thread_key_sets_the_topic(self, bot, recorded):
        await DataDriver.loaded("telegram").send(_row(bot), thread_key="-100123/42", to="", text="hi")
        assert (bot.bodies[-1]["chat_id"], bot.bodies[-1]["message_thread_id"]) == ("-100123", 42)

    async def test_too_long_text_is_refused_never_truncated(self, bot):
        with pytest.raises(ValueError, match="4096"):
            await DataDriver.loaded("telegram").send(_row(bot), thread_key="1", to="1", text="x" * (MAX_TEXT_LEN + 1))
        assert bot.requests == []

    async def test_no_chat_anywhere_is_refused(self, bot):
        with pytest.raises(ValueError, match="chat id"):
            await DataDriver.loaded("telegram").send(_row(bot), thread_key="", to="", text="hi")


async def test_the_token_never_reaches_an_error_message():
    row = SimpleNamespace(id="ds-tg", provider="telegram", config={"base_url": "http://127.0.0.1:9"})
    with pytest.raises(Exception) as caught:
        await DataDriver.loaded("telegram").traverse(row, _view())
    assert TOKEN not in str(caught.value)


class TestTelegramMessageSpec:
    _inbound = SimpleNamespace(external_id=f"{CHAT}/7", thread_key=CHAT, author_external_id="444555666", name="Eran")

    def test_reply_targets_the_chat_not_the_author(self):
        reply = TelegramMessageSpec.reply_to(self._inbound, body="ack")
        assert (reply.to, reply.thread_key, reply.reply_to_external_id, reply.body) == ([CHAT], CHAT, f"{CHAT}/7", "ack")

    def test_a_forum_reply_keeps_the_topic_but_targets_the_chat(self):
        m = SimpleNamespace(external_id="-100123/7", thread_key="-100123/42", author_external_id="4")
        reply = TelegramMessageSpec.reply_to(m, body="ack")
        assert (reply.to, reply.thread_key) == (["-100123"], "-100123/42")

    def test_it_is_a_frozen_forbidding_value(self):
        reply = TelegramMessageSpec.reply_to(self._inbound, body="ack")
        with pytest.raises(ValidationError):
            reply.body = "changed"
        with pytest.raises(ValidationError):
            TelegramMessageSpec(to=["1"], body="x", subject="no such field")


async def test_the_double_delivers_after_the_source_exists_and_records_the_reply(monkeypatch):
    """The matrix double: nothing before a delivery, the delivered message on the next sync — even
    past a committed offset — and a send through the source in ``sent()``."""
    Double = load_module(SHIPPED_ROOT / "telegram" / "tests", "matrix").Double

    recorded: list = []

    async def _ingest(item, **_kw):
        recorded.append(item)

    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_item", _ingest)
    with Double() as double:
        monkeypatch.setattr(DataDriver.loaded("telegram"), "credentials_for", double.credentials)
        row = SimpleNamespace(id="ds-tg", provider="telegram", name="Telegram bot", config=double.config, **double.fields)
        driver = DataDriver.loaded("telegram")

        first = await driver.traverse(row, _view())
        assert first.items == [] and double.sent() == []

        delivered = double.deliver("are you there?", sender="555")
        second = await driver.traverse(row, _view(first))
        (item,) = second.items
        assert (item.external_id, item.body, item.author_external_id, item.thread_key) == (f"555/{delivered['external_id']}", "are you there?", "555", "555")
        assert item.occurred_at >= datetime.now(timezone.utc).replace(microsecond=0).isoformat()[:16]

        # A delivery queued after a poll committed its offset lands above that offset.
        later = double.deliver("still there?", sender="555")
        third = await driver.traverse(row, _view(second))
        assert [i.external_id for i in third.items] == [f"555/{later['external_id']}"]

        out = await driver.send(row, thread_key="555", to="555", text="yes", in_reply_to=f"555/{delivered['external_id']}")
        assert out.status == SendStatus.SENT
        assert double.sent() == [{"to": "555", "text": "yes", "thread": int(delivered["external_id"]), "external_id": out.external_id.split("/")[1], "files": []}]


# ── files, quotes and reactions ─────────────────────────────────────────────


def _binding(bot) -> SourceBinding:
    return SourceBinding(
        config={"base_url": bot.base}, credentials=ResolvedSecrets(shape=AuthShape.SECRETS, values={"bot_token": SecretStr(TOKEN)})
    )


async def _fetched(bot, *updates):
    """The items one page of ``updates`` maps to, straight from the source (no staging)."""
    bot.updates = list(updates)
    async with TelegramSource(_binding(bot)) as source:
        return (await source.fetch()).items


@pytest.fixture
def files_home(monkeypatch, tmp_path):
    """Staged and kept files land under the test's own tmp dir."""
    monkeypatch.setattr(DataDriver.loaded("telegram"), "files_root", lambda _row: tmp_path / "files")
    return tmp_path / "files"


@pytest.fixture
def recorded(monkeypatch):
    seen: list = []

    async def _ingest(item, **_kw):
        seen.append(item)

    monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_item", _ingest)
    return seen


class TestSendingFiles:
    @pytest.mark.parametrize(("kind", "method", "field", "filename"), [
        ("image", "sendPhoto", "photo", "p.jpg"),
        ("video", "sendVideo", "video", "v.mp4"),
        ("audio", "sendAudio", "audio", "a.mp3"),
        ("voice", "sendVoice", "voice", "n.ogg"),
        ("document", "sendDocument", "document", "d.pdf"),
        ("sticker", "sendSticker", "sticker", "s.webp"),
    ])
    async def test_each_kind_uploads_through_its_own_method(self, bot, recorded, files_home, tmp_path, kind, method, field, filename):
        path = tmp_path / filename
        path.write_bytes(b"bytes of " + filename.encode())
        out = await DataDriver.loaded("telegram").send(_row(bot), thread_key=CHAT, to=CHAT, text="", files=(local_file(path, as_=kind),))
        ((sent_method, fields, uploaded),) = bot.uploads
        assert (sent_method, set(uploaded)) == (method, {field})
        assert uploaded[field][0] == filename and uploaded[field][2] == b"bytes of " + filename.encode()
        assert fields == {"chat_id": CHAT} and out.external_id == f"{CHAT}/8"
        ((copy,),) = [recorded[0].data.attachments]
        assert copy.origin.key.startswith("file-"), "the sent copy names the file as Telegram does"
        assert copy.data.path.startswith(str(files_home)) and open(copy.data.path, "rb").read() == b"bytes of " + filename.encode()

    async def test_the_body_rides_as_the_caption(self, bot, recorded, files_home, tmp_path):
        path = tmp_path / "p.jpg"
        path.write_bytes(b"jpeg")
        await DataDriver.loaded("telegram").send(_row(bot), thread_key=CHAT, to=CHAT, text="look at this", files=(local_file(path),))
        ((method, fields, _),) = bot.uploads
        assert (method, fields["caption"]) == ("sendPhoto", "look at this")
        assert [m for m, _ in bot.requests if m.startswith("send")] == ["sendPhoto"], "one message: the text is the caption, not a second send"

    async def test_a_quoting_file_send_carries_reply_parameters(self, bot, recorded, files_home, tmp_path):
        path = tmp_path / "d.pdf"
        path.write_bytes(b"%PDF")
        await DataDriver.loaded("telegram").send(_row(bot), thread_key=CHAT, to=CHAT, text="", in_reply_to=f"{CHAT}/7", files=(local_file(path),))
        ((_, fields, _),) = bot.uploads
        assert json.loads(fields["reply_parameters"]) == {"message_id": 7}

    async def test_a_sticker_takes_no_caption_so_the_body_goes_first(self, bot, recorded, files_home, tmp_path):
        path = tmp_path / "s.webp"
        path.write_bytes(b"RIFF")
        await DataDriver.loaded("telegram").send(_row(bot), thread_key=CHAT, to=CHAT, text="hi", files=(local_file(path, as_="sticker"),))
        assert [m for m, _ in bot.requests if m.startswith("send")] == ["sendMessage", "sendSticker"]
        assert "caption" not in bot.uploads[0][1]

    async def test_a_photo_over_10_mb_is_refused_before_any_request(self, bot, tmp_path):
        path = tmp_path / "big.jpg"
        with path.open("wb") as fh:
            fh.truncate(10_000_001)
        with pytest.raises(ValueError, match="document"):
            await DataDriver.loaded("telegram").send(_row(bot), thread_key=CHAT, to=CHAT, text="", files=(local_file(path),))
        assert bot.requests == []

    async def test_a_file_that_is_not_local_is_refused(self, bot):
        foreign = FileItem(origin=TelegramSource(_binding(bot)).origin("file-1", "files"), data=MessageFileData(name="x", as_=FileKind.DOCUMENT))
        from flow_sdk.sources.values.items import MessageData  # noqa: PLC0415

        async with TelegramSource(_binding(bot)) as source:
            with pytest.raises(ValueError, match="local"):
                await source.send(MessageData(conversation=source.chat_origin(CHAT), attachments=(foreign,)))
        assert bot.requests == []


class TestReceivingFiles:
    async def test_a_photo_is_its_largest_size(self, bot):
        small, large = bot.hold(b"s"), bot.hold(b"large")
        photo = [{**small, "width": 90, "height": 90, "file_size": 1}, {**large, "width": 1280, "height": 960, "file_size": 5}]
        (item,) = await _fetched(bot, _update(900001, text=None, caption="sunset", photo=photo))
        (f,) = item.data.attachments
        assert (f.origin.key, f.origin.namespace.rsplit("/", 1)[-1] == "files", f.data.as_, f.data.media_type) == (large["file_id"], True, FileKind.IMAGE, "image/jpeg")
        assert (f.data.name, f.data.size, f.data.caption, item.data.text) == (f"photo-{large['file_unique_id']}.jpg", 5, "sunset", "sunset")

    @pytest.mark.parametrize(("field", "extra", "kind", "media_type", "name"), [
        ("voice", {"mime_type": "audio/ogg"}, FileKind.VOICE, "audio/ogg", "voice-{u}.ogg"),
        ("document", {"file_name": "report.pdf", "mime_type": "application/pdf"}, FileKind.DOCUMENT, "application/pdf", "report.pdf"),
        ("sticker", {}, FileKind.STICKER, "image/webp", "sticker-{u}.webp"),
        ("video_note", {}, FileKind.VIDEO, "video/mp4", "video_note-{u}.mp4"),
        ("audio", {"mime_type": "audio/mpeg", "file_name": "song.mp3"}, FileKind.AUDIO, "audio/mpeg", "song.mp3"),
    ])
    async def test_each_media_field_maps_to_its_kind(self, bot, field, extra, kind, media_type, name):
        held = bot.hold(b"x")
        (item,) = await _fetched(bot, _update(900001, text=None, **{field: {**held, **extra}}))
        (f,) = item.data.attachments
        assert (f.data.as_, f.data.media_type, f.data.name) == (kind, media_type, name.format(u=held["file_unique_id"]))
        assert f.data.caption is None and item.data.text == ""

    async def test_an_animation_is_one_video_not_also_its_document(self, bot):
        held = bot.hold(b"gif")
        gif = {**held, "file_name": "a.mp4", "mime_type": "video/mp4"}
        (item,) = await _fetched(bot, _update(900001, text=None, animation=gif, document=gif))
        assert [f.data.as_ for f in item.data.attachments] == [FileKind.VIDEO]

    async def test_open_downloads_the_bytes_by_file_path(self, bot):
        held = bot.hold(b"0123456789" * 10, ext="pdf")
        (item,) = await _fetched(bot, _update(900001, document={**held, "file_name": "r.pdf"}))
        async with TelegramSource(_binding(bot)) as source:
            async with source.open(item.data.attachments[0], chunk_size=16) as chunks:
                got = [chunk async for chunk in chunks]
        assert b"".join(got) == b"0123456789" * 10
        assert [m for m, _ in bot.requests][-2:] == ["getFile", "download"]

    async def test_a_file_over_20_mb_is_refused_by_name(self, bot):
        held = bot.hold(b"small", size=25_000_000)
        (item,) = await _fetched(bot, _update(900001, document={**held, "file_name": "huge.zip"}))
        async with TelegramSource(_binding(bot)) as source:
            with pytest.raises(Unsupported, match="20 MB at most"):
                async with source.open(item.data.attachments[0]):
                    pass
            unsized = item.data.attachments[0].model_copy(update={"data": item.data.attachments[0].data.model_copy(update={"size": None})})
            with pytest.raises(Unsupported, match="20 MB at most"):
                async with source.open(unsized):
                    pass

    async def test_a_traversal_stages_the_bytes_or_says_why_not(self, bot, files_home):
        ok, huge = bot.hold(b"voice bytes", ext="ogg"), bot.hold(b"x", size=25_000_000)
        bot.updates = [_update(900001, message_id=1, voice={**ok, "mime_type": "audio/ogg"}), _update(900002, message_id=2, document={**huge, "file_name": "huge.zip"})]
        result = await DataDriver.loaded("telegram").traverse(_row(bot), _view())
        staged = {i.external_id: i for i in result.items}
        (voice,) = staged[f"{CHAT}/1"].data.attachments
        assert open(voice.data.path, "rb").read() == b"voice bytes"
        (lost,) = staged[f"{CHAT}/2"].data.attachments
        assert lost.data.path is None and "20 MB at most" in lost.data.fetch_error


class TestReactions:
    def test_the_channel_traits(self):
        assert TelegramSource.quotes is True and TelegramSource.reactions_per_actor == 1
        assert TelegramSource.files.caption_max == 1024 and FileKind.STICKER not in TelegramSource.files.caption_kinds
        assert TelegramSource.files.max_bytes[FileKind.IMAGE] == 10_000_000 and TelegramSource.files.max_bytes[FileKind.DOCUMENT] == 50_000_000

    async def test_the_queue_asks_for_messages_and_reactions(self, bot):
        await _fetched(bot)
        assert json.loads(bot.requests[-1][1]["allowed_updates"]) == ["message", "message_reaction"]

    async def test_a_reaction_report_is_state_on_the_reacted_message(self, bot):
        report = {"chat": {"id": int(CHAT), "type": "private"}, "message_id": 7, "user": {"id": 444555666, "username": "eran"},
                  "date": 1756700100, "old_reaction": [], "new_reaction": [{"type": "emoji", "emoji": "👍"}, {"type": "paid"}]}
        (reaction, message) = await _fetched(bot, {"update_id": 900010, "message_reaction": report}, _update(900011))
        assert isinstance(reaction.data, ReactionData)
        assert reaction.data.target == message.origin, "the target is the message's own origin"
        assert (reaction.data.emojis, reaction.data.mode, reaction.data.sender.origin.key, reaction.data.sender.name) == (("👍",), ReactionMode.SET, "444555666", "@eran")
        assert reaction.origin.key == "reaction:900010"

    async def test_taking_it_back_is_an_empty_set_and_the_cursor_moves_past_it(self, bot):
        report = {"chat": {"id": int(CHAT)}, "message_id": 7, "user": {"id": 444555666}, "date": 1756700100,
                  "old_reaction": [{"type": "emoji", "emoji": "👍"}], "new_reaction": []}
        bot.updates = [{"update_id": 900020, "message_reaction": report}]
        async with TelegramSource(_binding(bot)) as source:
            page = await source.fetch()
        (reaction,) = page.items
        assert reaction.data.emojis == () and page.resume_cursor == TelegramSource.resume_at(900021)

    async def test_react_sets_one_emoji_and_unreact_clears(self, bot):
        async with TelegramSource(_binding(bot)) as source:
            target = source.origin(f"{CHAT}/7")
            await source.react(target, "🔥")
            assert bot.bodies[-1] == {"chat_id": CHAT, "message_id": 7, "reaction": [{"type": "emoji", "emoji": "🔥"}]}
            await source.unreact(target)
            assert bot.bodies[-1] == {"chat_id": CHAT, "message_id": 7, "reaction": []}

    async def test_a_variation_selector_does_not_make_another_emoji(self, bot):
        async with TelegramSource(_binding(bot)) as source:
            await source.react(source.origin(f"{CHAT}/7"), "❤️")
        assert bot.bodies[-1]["reaction"] == [{"type": "emoji", "emoji": "❤"}]

    async def test_an_emoji_telegram_does_not_show_is_refused_by_name(self, bot):
        async with TelegramSource(_binding(bot)) as source:
            with pytest.raises(Rejected, match="✅"):
                await source.react(source.origin(f"{CHAT}/7"), "✅")
        assert [m for m, _ in bot.requests] == []

    def test_the_allowed_set_is_the_bot_api_list(self):
        reactions = asset_module("telegram").__name__.rsplit(".", 1)[0]
        allowed = __import__(f"{reactions}.reactions", fromlist=["ALLOWED_EMOJI"]).ALLOWED_EMOJI
        assert len(allowed) == 73 and "🦄" in allowed and "✅" not in allowed


async def test_the_double_carries_files_quotes_and_reactions_both_ways(monkeypatch, recorded, files_home, tmp_path):
    """The matrix double's channel half: a delivered file is staged, a quote names its message, a
    reaction lands as state on its target; what the bot sends and sets is observable."""
    Double = load_module(SHIPPED_ROOT / "telegram" / "tests", "matrix").Double
    with Double() as double:
        monkeypatch.setattr(DataDriver.loaded("telegram"), "credentials_for", double.credentials)
        row = SimpleNamespace(id="ds-tg", provider="telegram", name="Telegram bot", config=double.config, **double.fields)
        driver = DataDriver.loaded("telegram")

        first = double.deliver("hi", sender="555")
        shown = double.deliver("see this", sender="555", reply_to=f"555/{first['external_id']}",
                               files=[{"name": "note.ogg", "media_type": "audio/ogg", "as_": "voice", "bytes": b"OggS"}])
        passed = await driver.traverse(row, _view())
        item = {i.external_id: i for i in passed.items}[f"555/{shown['external_id']}"]
        (voice,) = item.data.attachments
        assert (voice.data.as_, voice.data.caption, open(voice.data.path, "rb").read()) == (FileKind.VOICE, "see this", b"OggS")
        assert item.reply_to_external_id == f"555/{first['external_id']}"

        double.react(f"555/{first['external_id']}", "👍", sender="555")
        (reaction,) = (await driver.traverse(row, _view(passed))).reactions
        assert (reaction.data.target.key, reaction.data.emojis) == (f"555/{first['external_id']}", ("👍",))

        path = tmp_path / "chart.png"
        path.write_bytes(b"\x89PNG")
        await driver.send(row, thread_key="555", to="555", text="the chart", files=(local_file(path),))
        (sent,) = double.sent()
        assert (sent["text"], sent["files"]) == ("the chart", [{"name": "chart.png", "media_type": "image/png", "as_": "image", "bytes": b"\x89PNG"}])

        await driver.react(row, reaction.data.target, "❤️")
        await driver.react(row, reaction.data.target, "", remove=True)
        assert double.reactions() == [{"target": f"555/{first['external_id']}", "emojis": ["❤"]}, {"target": f"555/{first['external_id']}", "emojis": []}]
