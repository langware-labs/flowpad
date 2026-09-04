"""Provider-agnostic send and reply-waiting behavior on ``DataSource``."""
from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from flow_sdk.builtin.data_source import DataSource
from flow_sdk.builtin.source_item import EmailMessageSpec, MessageSpec, SourceItem, SourceItemSpec
from flow_sdk.ingest.driver import SendOutcome

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _source() -> DataSource:
    return DataSource(name="Mailbox", provider="mail-test")


def _reply(source: DataSource, *, reply_to: str) -> SourceItem:
    return SourceItem(
        data_source_id=source.id,
        provider=source.provider,
        kind="content.message.email",
        segment_key="INBOX",
        external_id="<reply@example.com>",
        name="Re: Question",
        body="Answer",
        reply_to_external_id=reply_to,
    )


class TestDataSourceSend:
    @pytest.mark.asyncio
    async def test_email_spec_maps_onto_the_driver_contract(self, monkeypatch):
        source = _source()
        driver = AsyncMock()
        driver.sends = True
        driver.send.return_value = SendOutcome(external_id="<sent@example.com>")
        monkeypatch.setattr("flow_sdk.ingest.driver.get_driver", lambda provider: driver)

        outcome = await source.send(
            EmailMessageSpec(
                to=["friend@example.com"],
                subject="Question",
                body="Hello",
                thread_key="thread-1",
                reply_to_external_id="<parent@example.com>",
            )
        )

        assert outcome is driver.send.return_value
        driver.send.assert_awaited_once_with(
            source,
            thread_key="thread-1",
            to="friend@example.com",
            text="Hello",
            subject="Question",
            in_reply_to="<parent@example.com>",
        )

    @pytest.mark.asyncio
    async def test_non_email_message_has_no_subject(self, monkeypatch):
        source = _source()
        driver = AsyncMock()
        driver.sends = True
        driver.send.return_value = SendOutcome(external_id="message-1")
        monkeypatch.setattr("flow_sdk.ingest.driver.get_driver", lambda provider: driver)

        await source.send(MessageSpec(to=["chat-1"], body="Hello"))

        assert driver.send.await_args.kwargs["subject"] == ""

    @pytest.mark.asyncio
    async def test_attachments_refuse_before_provider_io(self, monkeypatch):
        from flow_sdk.schema.data_spec.dataset_spec import FileRef

        source = _source()
        get_driver = AsyncMock()
        monkeypatch.setattr("flow_sdk.ingest.driver.get_driver", get_driver)
        spec = EmailMessageSpec(
            to=["friend@example.com"],
            body="Hello",
            attachments=[FileRef(path="report.pdf")],
        )

        with pytest.raises(NotImplementedError, match="attachments"):
            await source.send(spec)
        get_driver.assert_not_called()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("recipients", [[], ["a@example.com", "b@example.com"]])
    async def test_exactly_one_recipient_is_required(self, recipients):
        with pytest.raises(ValueError, match="exactly one recipient"):
            await _source().send(EmailMessageSpec(to=recipients, body="Hello"))

    @pytest.mark.asyncio
    async def test_source_without_sending_driver_refuses(self, monkeypatch):
        source = _source()
        monkeypatch.setattr("flow_sdk.ingest.driver.get_driver", lambda provider: None)

        with pytest.raises(RuntimeError, match="mail-test driver cannot send"):
            await source.send(EmailMessageSpec(to=["friend@example.com"], body="Hello"))


class TestDataSourceExpectReply:
    @pytest.mark.asyncio
    async def test_existing_reply_returns_without_syncing(self, monkeypatch):
        source = _source()
        row = _reply(source, reply_to="  <SENT@Example.com>  ")
        get_all = AsyncMock(return_value=[row])
        sync = AsyncMock()
        monkeypatch.setattr(SourceItem, "get_all", get_all)
        monkeypatch.setattr("flow_sdk.ingest.sync.sync_source", sync)

        reply = await source.expect_reply(SendOutcome(external_id="sent@example.COM"))

        assert isinstance(reply, SourceItemSpec)
        assert reply.external_id == row.external_id
        assert reply.reply_to_external_id == row.reply_to_external_id
        sync.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_syncs_again_until_the_reply_is_ingested(self, monkeypatch):
        source = _source()
        rows: list[SourceItem] = []
        row = _reply(source, reply_to="<sent@example.com>")

        async def get_all(_query):
            return list(rows)

        async def sync(_source, *, now):
            rows.append(row)

        monkeypatch.setattr(SourceItem, "get_all", get_all)
        monkeypatch.setattr("flow_sdk.ingest.sync.sync_source", sync)

        reply = await source.expect_reply(SendOutcome(external_id="<sent@example.com>"))

        assert reply.external_id == row.external_id

    @pytest.mark.asyncio
    async def test_uses_a_driver_targeted_reply_lookup_when_available(self, monkeypatch):
        source = _source()
        found = SourceItemSpec.model_validate(
            {
                key: getattr(_reply(source, reply_to="<sent@example.com>"), key)
                for key in SourceItemSpec.model_fields
            }
        )
        driver = AsyncMock()
        driver.wait_for_reply = None
        driver.find_reply.return_value = found
        ingest = AsyncMock()
        sync = AsyncMock()
        monkeypatch.setattr(SourceItem, "get_all", AsyncMock(return_value=[]))
        monkeypatch.setattr("flow_sdk.ingest.driver.get_driver", lambda provider: driver)
        monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", ingest)
        monkeypatch.setattr("flow_sdk.ingest.sync.sync_source", sync)

        reply = await source.expect_reply(SendOutcome(external_id="<sent@example.com>"))

        assert reply is found
        driver.find_reply.assert_awaited_once_with(source, "<sent@example.com>")
        ingest.assert_awaited_once_with([found])
        sync.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_uses_a_driver_session_wait_when_available(self, monkeypatch):
        source = _source()
        found = SourceItemSpec.model_validate(
            {
                key: getattr(_reply(source, reply_to="<sent@example.com>"), key)
                for key in SourceItemSpec.model_fields
            }
        )
        driver = AsyncMock()
        driver.wait_for_reply.return_value = found
        ingest = AsyncMock()
        sync = AsyncMock()
        monkeypatch.setattr(SourceItem, "get_all", AsyncMock(return_value=[]))
        monkeypatch.setattr("flow_sdk.ingest.driver.get_driver", lambda provider: driver)
        monkeypatch.setattr("flow_sdk.ingest.ingestor.ingest_items", ingest)
        monkeypatch.setattr("flow_sdk.ingest.sync.sync_source", sync)

        reply = await source.expect_reply(SendOutcome(external_id="<sent@example.com>"))

        assert reply is found
        driver.wait_for_reply.assert_awaited_once_with(source, "<sent@example.com>")
        ingest.assert_awaited_once_with([found])
        sync.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_send_without_external_id_cannot_have_a_correlated_reply(self):
        with pytest.raises(ValueError, match="no external_id"):
            await _source().expect_reply(SendOutcome())


class TestReplySpecAsksTheChannel:
    """Building a reply must not mean guessing the addressing rule.

    The class IS the rule — `EmailMessageSpec` answers the author,
    `SlackMessageSpec` answers the channel — so a caller that names the class by
    hand on a Slack source addresses the reply to the person's user id, which
    Slack delivers as a DM instead of posting it where everyone is reading. The
    reply path was fixed by asking `driver.outbound_spec(source)`; this pins the
    SDK path, which is the other way in.
    """

    def test_a_slack_source_addresses_the_channel(self, monkeypatch):
        from types import SimpleNamespace

        from flow_sdk.builtin.source_item import SlackMessageSpec

        source = DataSource(name="Slack", provider="slack-test")
        monkeypatch.setattr(
            "flow_sdk.ingest.driver.get_driver",
            lambda _p: SimpleNamespace(outbound_spec=lambda _s: SlackMessageSpec),
        )
        item = SimpleNamespace(
            author_external_id="U06L8JSQJ1X",
            segment_key="C08L1P4C95J",
            thread_key="100.000100",
            external_id="100.000100",
            name="hello",
        )

        spec = source.reply_spec(item, body="on it")

        assert spec.to == ["C08L1P4C95J"], "the SDK path addressed the author — Slack DMs that"

    def test_an_email_source_still_addresses_the_author(self, monkeypatch):
        from types import SimpleNamespace

        source = _source()
        monkeypatch.setattr(
            "flow_sdk.ingest.driver.get_driver",
            lambda _p: SimpleNamespace(outbound_spec=lambda _s: EmailMessageSpec),
        )
        item = SimpleNamespace(
            author_external_id="friend@example.com",
            segment_key="INBOX",
            thread_key="t-1",
            external_id="<x@mail>",
            name="Question",
        )

        spec = source.reply_spec(item, body="answer")

        assert spec.to == ["friend@example.com"]
        assert spec.subject == "Re: Question"
