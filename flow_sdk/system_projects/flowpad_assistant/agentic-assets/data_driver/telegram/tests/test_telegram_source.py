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
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.testing import Subject, checks_for

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


class _Bot:
    """A Bot API: a queue of updates, chats it can post into, and every request it was asked."""

    def __init__(self, updates=None):
        self.updates = list(updates or [])
        self.chats = {CHAT, "-100123", "444555666"}
        self.requests, self.bodies, self.next_id = [], [], 8
        # The loopback server answers on its own thread while a test delivers on another: an id is
        # handed out under a lock, as the real Bot API never hands out one twice.
        self._ids = threading.Lock()

    def mint_id(self) -> int:
        with self._ids:
            minted, self.next_id = self.next_id, self.next_id + 1
        return minted

    def __call__(self, path, headers):
        route, _, query = path.partition("?")
        method = route.rsplit("/", 1)[-1]
        params = {k: v[0] for k, v in parse_qs(query).items()}
        body = json.loads(headers["_body"]) if headers.get("_body") else {}
        self.requests.append((method, params))
        self.bodies.append(body)
        if method == "getMe":
            return self._ok({"id": 777, "username": "my_bot"})
        if method == "getUpdates":
            offset, limit = int(params.get("offset") or 0), int(params.get("limit") or 100)
            return self._ok([u for u in self.updates if u["update_id"] >= offset][:limit])
        if str(body.get("chat_id")) not in self.chats:
            return 400, json.dumps({"ok": False, "error_code": 400, "description": "Bad Request: chat not found"}).encode(), {}
        sent = {"message_id": self.mint_id(), "date": int(time.time()), "chat": {"id": int(body["chat_id"]), "type": "private"},
                "from": {"id": 777, "username": "my_bot", "is_bot": True}, "text": body["text"]}
        if body.get("reply_to_message_id"):
            sent["reply_to_message"] = {"message_id": body["reply_to_message_id"]}
        if body.get("message_thread_id"):
            sent["message_thread_id"] = body["message_thread_id"]
        return self._ok(sent)

    @staticmethod
    def _ok(result):
        return 200, json.dumps({"ok": True, "result": result}).encode(), {"Content-Type": "application/json"}


@pytest.fixture(autouse=True)
def _token(monkeypatch):
    """The token is the ``telegram`` credential (TELEGRAM_BOT_TOKEN), never config."""
    async def resolve(_row):
        return Credentials(shape=AuthShape.SECRETS, values={"bot_token": SecretStr(TOKEN)})

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
    bot.updates = [_update(900000 + n, message_id=n) for n in (1, 2, 3)]
    binding = SourceBinding(
        config={"base_url": bot.base}, credentials=Credentials(shape=AuthShape.SECRETS, values={"bot_token": SecretStr(TOKEN)})
    )
    probe = TelegramSource(binding)
    await check.run(Subject(
        source=lambda: TelegramSource(binding),
        seeded=tuple(probe.origin(f"{CHAT}/{n}") for n in (1, 2, 3)),
        conversation=probe.chat_origin(CHAT),
        recipient=UserProfile(origin=probe.origin("444555666"), name="Eran"),
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
    @pytest.fixture
    def recorded(self, monkeypatch):
        seen: list = []

        async def _ingest(item, **_kw):
            seen.append(item)

        monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_item", _ingest)
        return seen

    async def test_a_reply_maps_onto_send_message(self, bot, recorded):
        out = await DataDriver.loaded("telegram").send(_row(bot), thread_key=CHAT, to=CHAT, text="hi", in_reply_to=f"{CHAT}/7")
        assert bot.requests[-1][0] == "sendMessage"
        assert bot.bodies[-1] == {"chat_id": CHAT, "text": "hi", "reply_to_message_id": 7}
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
        assert double.sent() == [{"to": "555", "text": "yes", "thread": int(delivered["external_id"]), "external_id": out.external_id.split("/")[1]}]
