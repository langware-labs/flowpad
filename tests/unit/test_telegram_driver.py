"""The Telegram transport — the bot account as a standard message source.

Pins the three Telegram facts the driver is built around: the offset-acked
queue (the committed cursor IS the ack), the per-chat message ids (external_id
carries the chat), and the missing echo (send records its own copy, because a
bot never receives its own messages). Plus the outbound spec's chat-targeted
reply — the reason ``MessageSpec`` grew a hierarchy.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from flow_sdk.builtin.source_item import TelegramMessageSpec
from flow_sdk.ingest.driver import SendStatus
from flow_sdk.ingest.drivers.telegram import MAX_TEXT_LEN, TelegramDriver

MESSAGE = {
    "message_id": 7,
    "date": 1756700000,
    "chat": {"id": 111222333, "type": "private", "first_name": "Eran"},
    "from": {"id": 444555666, "username": "eran", "first_name": "Eran"},
    "text": "hello bot",
}

UPDATE = {"update_id": 900001, "message": MESSAGE}


def _source(**config):
    base = {"bot_token": "123:TEST"}
    base.update(config)
    return SimpleNamespace(
        id="ds-tg", name="Telegram bot", config=base,
        account_key="@my_bot", account_identities=["777", "@my_bot"],
    )


def _cursor(state=None):
    return SimpleNamespace(segment_key="updates", state=state or {}, window_start=None, first_run=not state)


class TestItAcceptsAndSends:
    def test_it_declares_that_it_sends(self):
        assert TelegramDriver.sends is True

    def test_it_is_its_own_channel(self):
        assert TelegramDriver().channel_for(_source()) == "telegram"

    def test_the_token_is_the_identity_key(self):
        # What blocks.Inbox matches on to reuse a source instead of minting a twin.
        assert TelegramDriver.identity_config_key == "bot_token"

    async def test_the_queue_is_one_stream(self):
        streams = await TelegramDriver().segments(_source())
        assert [s.key for s in streams] == ["updates"]


class TestMapping:
    driver = TelegramDriver()

    def test_external_id_carries_the_chat(self):
        # message_id is only unique PER CHAT — a bare "7" would collide across
        # every conversation the bot is in.
        item = self.driver._to_item(_source(), MESSAGE)
        assert item.external_id == "111222333/7"
        assert item.thread_key == "111222333"

    def test_a_forum_topic_extends_the_thread(self):
        msg = {
            **MESSAGE,
            "chat": {"id": -100123, "type": "supergroup", "title": "Team", "is_forum": True},
            "message_thread_id": 42,
        }
        item = self.driver._to_item(_source(), msg)
        assert item.thread_key == "-100123/42"
        assert item.external_id == "-100123/7"

    def test_it_produces_chat_kind_so_the_inbox_accepts_it(self):
        # Same record kind as Slack: the channel differs, the record does not.
        assert self.driver._to_item(_source(), MESSAGE).kind == "content.message.chat"

    def test_author_and_time_are_normalized(self):
        item = self.driver._to_item(_source(), MESSAGE)
        assert item.author_external_id == "444555666"
        assert item.author_display == "@eran"
        assert item.occurred_at.startswith("2025") or item.occurred_at.startswith("2026")
        assert item.body == "hello bot"

    def test_a_caption_stands_in_for_text(self):
        item = self.driver._to_item(_source(), {**MESSAGE, "text": None, "caption": "a photo"})
        assert item.body == "a photo"

    def test_no_identity_means_no_item(self):
        assert self.driver._to_item(_source(), {"chat": {}, "message_id": None}) is None


class TestCursorAck:
    @pytest.mark.asyncio
    async def test_the_committed_offset_is_what_is_sent_back(self, monkeypatch):
        driver = TelegramDriver()
        seen: dict = {}

        async def _call(source, method, params=None, json_body=None):
            seen["params"] = params or {}
            return {"ok": True, "result": [UPDATE]}

        monkeypatch.setattr(driver, "_call", _call)
        monkeypatch.setattr(driver, "_ensure_identity", _noop)
        result = await driver.fetch(_source(), _cursor({"next_offset": 900001}))

        # The offset PASSED is the committed one — that is the ack. The NEXT
        # state advances past what this fetch returned.
        assert seen["params"]["offset"] == 900001
        assert result.next_state["next_offset"] == 900002
        assert [i.external_id for i in result.items] == ["111222333/7"]

    @pytest.mark.asyncio
    async def test_a_first_run_sends_no_offset(self, monkeypatch):
        driver = TelegramDriver()
        seen: dict = {}

        async def _call(source, method, params=None, json_body=None):
            seen["params"] = params or {}
            return {"ok": True, "result": []}

        monkeypatch.setattr(driver, "_call", _call)
        monkeypatch.setattr(driver, "_ensure_identity", _noop)
        result = await driver.fetch(_source(), _cursor())

        assert "offset" not in seen["params"]
        assert result.unchanged is True
        assert "next_offset" not in result.next_state

    @pytest.mark.asyncio
    async def test_non_message_updates_still_advance_the_offset(self, monkeypatch):
        # An edit or callback left unacked would wedge the queue forever.
        driver = TelegramDriver()

        async def _call(source, method, params=None, json_body=None):
            return {"ok": True, "result": [{"update_id": 900005, "edited_message": {**MESSAGE}}]}

        monkeypatch.setattr(driver, "_call", _call)
        monkeypatch.setattr(driver, "_ensure_identity", _noop)
        result = await driver.fetch(_source(), _cursor({"next_offset": 900001}))

        assert result.items == []
        assert result.next_state["next_offset"] == 900006


class TestSend:
    @pytest.mark.asyncio
    async def test_it_maps_the_spec_shape_onto_sendMessage(self, monkeypatch):
        driver = TelegramDriver()
        seen: dict = {}

        async def _call(source, method, params=None, json_body=None):
            seen["method"] = method
            seen["body"] = json_body
            return {"ok": True, "result": {**MESSAGE, "message_id": 8, "from": {"id": 777, "username": "my_bot"}}}

        monkeypatch.setattr(driver, "_call", _call)
        recorded: list = []

        async def _ingest(items, **kw):
            recorded.extend(items)

        monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", _ingest)
        out = await driver.send(
            _source(), thread_key="111222333", to="111222333", text="hi", in_reply_to="111222333/7"
        )

        assert seen["method"] == "sendMessage"
        assert seen["body"]["chat_id"] == "111222333"
        # The reply id is the MESSAGE half of the external id, as an int.
        assert seen["body"]["reply_to_message_id"] == 7
        assert out.status is SendStatus.SENT
        assert out.external_id == "111222333/8"

    @pytest.mark.asyncio
    async def test_the_sent_copy_is_recorded_because_nothing_will_echo_it(self, monkeypatch):
        driver = TelegramDriver()

        async def _call(source, method, params=None, json_body=None):
            return {"ok": True, "result": {**MESSAGE, "message_id": 9, "from": {"id": 777, "username": "my_bot"}}}

        monkeypatch.setattr(driver, "_call", _call)
        recorded: list = []

        async def _ingest(items, **kw):
            recorded.extend(items)

        monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", _ingest)
        out = await driver.send(_source(), thread_key="111222333", to="111222333", text="hi")

        assert out.recorded is True
        assert [i.external_id for i in recorded] == ["111222333/9"]
        # Attribution: the copy's author is the BOT (in account_identities),
        # which is how the projection knows it is ours.
        assert recorded[0].author_external_id == "777"

    @pytest.mark.asyncio
    async def test_a_forum_thread_key_sets_the_topic(self, monkeypatch):
        driver = TelegramDriver()
        seen: dict = {}

        async def _call(source, method, params=None, json_body=None):
            seen["body"] = json_body
            return {"ok": True, "result": {**MESSAGE, "message_id": 10}}

        monkeypatch.setattr(driver, "_call", _call)

        async def _ingest(items, **kw):
            return None

        monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", _ingest)
        await driver.send(_source(), thread_key="-100123/42", to="", text="hi")

        assert seen["body"]["chat_id"] == "-100123"
        assert seen["body"]["message_thread_id"] == 42

    @pytest.mark.asyncio
    async def test_too_long_text_is_refused_never_truncated(self):
        with pytest.raises(ValueError, match="4096"):
            await TelegramDriver().send(
                _source(), thread_key="1", to="1", text="x" * (MAX_TEXT_LEN + 1)
            )

    @pytest.mark.asyncio
    async def test_no_chat_anywhere_is_refused(self):
        with pytest.raises(ValueError, match="chat id"):
            await TelegramDriver().send(_source(), thread_key="", to="", text="hi")


class TestTelegramMessageSpec:
    _inbound = SimpleNamespace(
        external_id="111222333/7",
        thread_key="111222333",
        author_external_id="444555666",
        name="Eran",
    )

    def test_reply_targets_the_chat_not_the_author(self):
        reply = TelegramMessageSpec.reply_to(self._inbound, body="ack")
        assert reply.to == ["111222333"]  # the chat — NOT 444555666
        assert reply.thread_key == "111222333"
        assert reply.reply_to_external_id == "111222333/7"
        assert reply.body == "ack"

    def test_a_forum_reply_keeps_the_topic_but_targets_the_chat(self):
        m = SimpleNamespace(external_id="-100123/7", thread_key="-100123/42", author_external_id="4")
        reply = TelegramMessageSpec.reply_to(m, body="ack")
        assert reply.to == ["-100123"]
        assert reply.thread_key == "-100123/42"

    def test_it_is_a_frozen_forbidding_value(self):
        reply = TelegramMessageSpec.reply_to(self._inbound, body="ack")
        with pytest.raises(ValidationError):
            reply.body = "changed"
        with pytest.raises(ValidationError):
            TelegramMessageSpec(to=["1"], body="x", subject="no such field")


async def _noop(*a, **kw):
    return None
