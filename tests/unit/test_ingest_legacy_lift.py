"""The flat envelope lifts into the contract's value by one rule, with nothing guessed."""
from __future__ import annotations

from types import SimpleNamespace

from flow_sdk.ingest.legacy_lift import lift, origin_of
from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec
from flow_sdk.sources import CloudOrigin, EmailMessageData, FeedItemData, MessageData

GMAIL = SimpleNamespace(channel="gmail", provider="agent", account_key="me@x.test")


def _env(**kw) -> SourceItemSpec:
    base = dict(data_source_id="ds", provider="agent", kind="content.message.email", segment_key="INBOX", external_id="m1")
    return SourceItemSpec(**{**base, **kw})


def test_the_channel_and_the_account_scope_the_origin():
    assert origin_of(GMAIL, _env()) == CloudOrigin(kind="gmail", namespace="me@x.test/INBOX", key="m1")
    feed = origin_of(None, _env(provider="rss", segment_key="https://f.test/x.xml"))
    assert feed == CloudOrigin(kind="rss", namespace="https://f.test/x.xml", key="m1"), "no source row, no account"


def test_an_email_keeps_its_thread_sender_and_subject():
    item = lift(GMAIL, _env(name="Hi", body="b", thread_key="t1", author_external_id="a@x.test", author_display="A",
                            reply_to_external_id="m0", occurred_at="2026-07-30T10:00:00Z"))
    assert isinstance(item.data, EmailMessageData) and item.data.subject == "Hi" and item.data.text == "b"
    assert item.data.conversation.key == "t1" and item.data.in_reply_to.key == "m0"
    assert item.data.sender.origin == CloudOrigin(kind="gmail", namespace="me@x.test", key="a@x.test")
    assert item.data.sent_at.isoformat() == "2026-07-30T10:00:00+00:00"


def test_a_chat_is_a_message_and_anything_else_a_feed_item():
    assert type(lift(GMAIL, _env(kind="content.message.chat")).data) is MessageData
    feed = lift(None, _env(kind="content.feed.item", name="T", author_display="Someone"))
    assert isinstance(feed.data, FeedItemData) and feed.data.author is None and feed.data.byline == "Someone"


def test_what_the_envelope_already_carries_is_kept():
    given = CloudOrigin(kind="k", namespace="n", key="x")
    assert lift(GMAIL, _env(origin=given)).origin is given
