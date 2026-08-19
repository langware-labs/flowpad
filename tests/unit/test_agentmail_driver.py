"""The AgentMail transport — the one that can actually send.

Its reason for existing is the asymmetry: the harness's Gmail connector has no
send verb, so a reply through it stops as a draft. These tests pin the two
things that make this driver different, plus the mapping that lets everything
above it stay shared.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.ingest.driver import SendStatus
from flow_sdk.ingest.drivers.agentmail import AgentMailDriver, _address_of
from flow_sdk.ingest.health import SourceError

MSG = {
    "message_id": "<abc@email.amazonses.com>",
    "thread_id": "t-1",
    "timestamp": "2026-08-02T08:28:47.206Z",
    "from": "Joe the FlowPad agent <joe@agentmail.to>",
    "to": ["eran@langware.ai"],
    "subject": "Round trip",
    "preview": "Hello there.",
}


def _source(**config):
    base = {"inbox": "me@agentmail.to", "api_key": "am_test"}
    base.update(config)
    return SimpleNamespace(id="ds-1", name="Agent mailbox", config=base)


class TestItAcceptsAndSends:
    def test_it_declares_that_it_sends(self):
        # The whole point: the Gmail connector cannot, this can.
        assert AgentMailDriver.sends is True

    def test_it_is_its_own_channel(self):
        assert AgentMailDriver().channel_for(_source()) == "agentmail"

    def test_one_inbox_is_one_stream(self):
        streams = AgentMailDriver().segments(_source())
        assert [s.key for s in streams] == ["me@agentmail.to"]


class TestMapping:
    driver = AgentMailDriver()

    def test_the_providers_own_id_becomes_the_external_id(self):
        # Identity must stay stable across re-fetches AND across any other
        # driver that sees the same mail.
        item = self.driver._to_item(_source(), MSG)
        assert item.external_id == "<abc@email.amazonses.com>"
        assert item.thread_key == "t-1"

    def test_the_sender_is_split_into_name_and_address(self):
        item = self.driver._to_item(_source(), MSG)
        assert item.author_display == "Joe the FlowPad agent <joe@agentmail.to>"
        # The address alone is what `_sender_for` compares against
        # `account_identities` to recognise our own mail.
        assert item.author_external_id == "joe@agentmail.to"

    def test_it_produces_message_kind_so_the_inbox_accepts_it(self):
        # `content.message.*` is the gate; a feed kind would be silently dropped.
        assert self.driver._to_item(_source(), MSG).kind == "content.message.email"

    def test_a_bare_address_survives_parsing(self):
        assert _address_of("joe@agentmail.to") == "joe@agentmail.to"
        assert _address_of("") == ""


class TestCursor:
    @pytest.mark.asyncio
    async def test_it_only_returns_what_is_newer_than_the_high_water(self, monkeypatch):
        driver = AgentMailDriver()
        older = {**MSG, "message_id": "<old@x>", "timestamp": "2026-08-01T00:00:00.000Z"}

        async def _get(*a, **kw):
            return {"messages": [MSG, older]}

        monkeypatch.setattr(driver, "_get", _get)
        cursor = SimpleNamespace(
            segment_key="me@agentmail.to",
            state={"high_water": "2026-08-02T00:00:00.000Z"},
            window_start=None,
            first_run=False,
        )
        result = await driver.fetch(_source(), cursor)

        assert [i.external_id for i in result.items] == ["<abc@email.amazonses.com>"]
        assert result.next_state["high_water"] == MSG["timestamp"]

    @pytest.mark.asyncio
    async def test_nothing_new_is_reported_unchanged(self, monkeypatch):
        driver = AgentMailDriver()

        async def _get(*a, **kw):
            return {"messages": []}

        monkeypatch.setattr(driver, "_get", _get)
        cursor = SimpleNamespace(segment_key="i", state={}, window_start=None, first_run=True)
        assert (await driver.fetch(_source(), cursor)).unchanged is True


class TestSend:
    @pytest.mark.asyncio
    async def test_a_reply_uses_the_reply_route_with_an_ENCODED_id(self, monkeypatch):
        driver = AgentMailDriver()
        seen: dict = {}

        async def _post(source, path, body):
            seen["path"] = path
            seen["body"] = body
            return {"message_id": "<new@x>"}

        monkeypatch.setattr(driver, "_post", _post)
        out = await driver.send(
            _source(), thread_key="t-1", to="joe@agentmail.to", text="hi", in_reply_to="<abc@email.amazonses.com>"
        )

        # The RFC 5322 id rides in the PATH and contains `<`, `>` and `@`.
        # Passing it raw is a 400 that reads like a bad body — this is the bug
        # that cost a debugging cycle.
        assert "%3Cabc%40email.amazonses.com%3E" in seen["path"]
        assert seen["path"].endswith("/reply")
        assert out.status is SendStatus.SENT
        assert out.external_id == "<new@x>"

    @pytest.mark.asyncio
    async def test_without_a_parent_it_starts_a_new_message(self, monkeypatch):
        driver = AgentMailDriver()
        seen: dict = {}

        async def _post(source, path, body):
            seen.update(path=path, body=body)
            return {"message_id": "<new@x>"}

        monkeypatch.setattr(driver, "_post", _post)
        await driver.send(_source(), thread_key="", to="joe@agentmail.to", text="hi", subject="Hello")
        assert seen["path"].endswith("/messages/send")
        assert seen["body"]["to"] == ["joe@agentmail.to"]
        assert seen["body"]["subject"] == "Hello"

    @pytest.mark.asyncio
    async def test_the_sent_copy_is_not_recorded_here(self, monkeypatch):
        driver = AgentMailDriver()

        async def _post(*a, **kw):
            return {"message_id": "<new@x>"}

        monkeypatch.setattr(driver, "_post", _post)
        out = await driver.send(_source(), thread_key="", to="j@x.to", text="hi")
        # AgentMail returns the sent copy from the same list endpoint `fetch`
        # reads, so the ingest path records it once. Writing it here too would
        # be the same row twice.
        assert out.recorded is False


class TestConfigFailures:
    """A missing key needs a human; a flaky network does not. The two must not
    be reported the same way, or a typo parks the source forever in a retry."""

    def test_a_missing_inbox_is_a_config_error(self):
        with pytest.raises(SourceError) as caught:
            AgentMailDriver()._inbox(SimpleNamespace(config={}))
        assert caught.value.code == "no_inbox"

    def test_a_missing_key_is_a_config_error(self):
        with pytest.raises(SourceError) as caught:
            AgentMailDriver()._auth(SimpleNamespace(config={"inbox": "i"}))
        assert caught.value.code == "no_api_key"
