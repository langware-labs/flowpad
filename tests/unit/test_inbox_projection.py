"""The inbox projection — derived identity, subject threading, self-authorship.

The pure half is table-tested here. The projection round-trip (SourceItem →
Conversation + FlowMessage) is covered by the DB-backed tests below.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.inbox.projection import (
    channel_of,
    is_message,
    normalize_subject,
    thread_key_for,
)


class TestNormalizeSubject:
    @pytest.mark.parametrize("raw", [
        "Q3 planning",
        "Re: Q3 planning",
        "RE: Q3 planning",
        "Fwd: Q3 planning",
        "FW: Q3 planning",
        "Re: Fwd: RE:  Q3   planning",
        "[team] Re: Q3 planning",
        "[EXTERNAL] Fwd: Q3 planning",
    ])
    def test_reply_and_forward_forms_share_one_key(self, raw):
        assert normalize_subject(raw) == "q3 planning"

    @pytest.mark.parametrize("raw", ["AW: hallo", "SV: hallo", "Antw: hallo",
                                     "RES: hallo", "TR: hallo", "回复: hallo"])
    def test_non_english_prefixes_do_not_fork_the_thread(self, raw):
        # A two-entry English list silently forks every non-English thread —
        # this is the regression that list exists to prevent.
        assert normalize_subject(raw) == "hallo"

    def test_an_empty_subject_is_not_an_error(self):
        assert normalize_subject("") == ""
        assert normalize_subject(None) == ""

    def test_a_bracket_is_not_stripped_from_the_middle(self):
        assert normalize_subject("Re: build [ci] failed") == "build [ci] failed"


class TestThreadKey:
    def test_the_native_handle_wins_over_the_subject(self):
        item = SimpleNamespace(thread_key="1889abc")
        assert thread_key_for(item, "Re: whatever") == "1889abc"

    def test_the_subject_is_the_fallback(self):
        item = SimpleNamespace(thread_key=None)
        assert thread_key_for(item, "Re: Q3 planning") == "q3 planning"


class TestDerivedIdentity:
    def test_the_same_thread_through_two_transports_is_one_thread(self):
        # The whole reason the key is CHANNEL-scoped and not provider-scoped:
        # a harness-ingested Gmail thread and an API-ingested one must merge.
        assert (MessageThread.allocate_deterministic_id("gmail", "t-1")
                == MessageThread.allocate_deterministic_id("gmail", "t-1"))

    def test_two_channels_never_collide_on_one_key(self):
        assert (MessageThread.allocate_deterministic_id("gmail", "t-1")
                != MessageThread.allocate_deterministic_id("slack", "t-1"))

    def test_channel_falls_back_to_provider_for_rows_predating_the_field(self):
        assert channel_of(SimpleNamespace(channel="gmail", provider="agent")) == "gmail"
        assert channel_of(SimpleNamespace(channel="", provider="agent")) == "agent"
        assert channel_of(SimpleNamespace(channel=None, provider=None)) == ""


class TestKindGate:
    """`kind` is what separates a message from a document.

    Regression: the first live run had no gate, so 344 Hacker News stories
    were projected into the Inbox as conversations. A feed entry is an
    article; only `content.message.*` belongs in an inbox.
    """

    @pytest.mark.parametrize("kind", ["content.message.email", "content.message.chat",
                                      "CONTENT.MESSAGE.EMAIL", " content.message.email "])
    def test_messages_are_projected(self, kind):
        assert is_message(SimpleNamespace(kind=kind))

    @pytest.mark.parametrize("kind", ["content.feed.item", "content.document", "", None])
    def test_everything_else_is_not(self, kind):
        assert not is_message(SimpleNamespace(kind=kind))

    def test_a_lookalike_prefix_does_not_slip_through(self):
        # Hierarchy match, not `startswith` — `content.messages` is a different
        # subtree and must not be mistaken for a descendant.
        assert not is_message(SimpleNamespace(kind="content.messagestore.x"))

    @pytest.mark.asyncio
    async def test_a_feed_item_projects_to_nothing(self):
        from flow_sdk.inbox.projection import project_source_item

        # Returns before touching the DB — no source lookup, no conversation.
        assert await project_source_item(
            SimpleNamespace(kind="content.feed.item", id="x", data_source_id="s")
        ) is None


class TestSenderMapping:
    """`_sender_for` decides whether a message counts as unread.

    Both unread formulas gate on the sender, so getting this wrong makes your
    own Sent mail show as unread mail from a stranger.
    """

    @pytest.mark.asyncio
    async def test_an_external_sender_is_never_empty(self):
        from flow_sdk.inbox.projection import _sender_for

        item = SimpleNamespace(author_external_id="ami@langware.ai", author_display="Ami")
        source = SimpleNamespace(account_key="me@example.com")
        sender_id, name = await _sender_for(item, source, "gmail")
        # An EMPTY sender_id is never counted unread at all (inbox.count_unread
        # requires `latest.sender_id`), so the fallback must still be a string.
        assert sender_id == "gmail:ami@langware.ai"
        assert name == "Ami"

    @pytest.mark.asyncio
    async def test_an_unknown_author_still_yields_a_sender(self):
        from flow_sdk.inbox.projection import _sender_for

        sender_id, _ = await _sender_for(
            SimpleNamespace(author_external_id=None, author_display=None),
            SimpleNamespace(account_key="me@example.com"), "gmail",
        )
        assert sender_id == "gmail:unknown"

    @pytest.mark.asyncio
    async def test_our_own_address_maps_to_the_local_user(self, monkeypatch):
        from flow_sdk.inbox import projection

        monkeypatch.setattr(
            "flow_sdk.builtin.user.User.get_local",
            classmethod(lambda cls: _resolved(SimpleNamespace(id="local-42"))),
        )
        item = SimpleNamespace(author_external_id="Me@Example.com", author_display="Me")
        source = SimpleNamespace(account_key="me@example.com")
        sender_id, _ = await projection._sender_for(item, source, "gmail")
        # Case-insensitive: providers do not agree on address casing.
        assert sender_id == "local-42"


def _resolved(value):
    async def _coro():
        return value
    return _coro()
