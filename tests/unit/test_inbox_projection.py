"""The inbox projection — lookup identity, subject threading, self-authorship.

The pure half is table-tested here. The projection round-trip (SourceItem →
Conversation + FlowMessage) is covered by the DB-backed tests below.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

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


class TestLookupIdentity:
    """Identity converges by LOOKUP now — `find_existing` over the natural key
    `(channel, thread_key)` — with ordinary uuid4 ids. The invariants the old
    derived ids carried are re-pinned at the row level in
    `test_flow_message_reference_row.py::test_message_thread_resolves_by_natural_key`
    (same key = one row; another channel = a miss)."""

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


class TestConcurrentPlacement:
    """Two lanes CAN project the same item at once — sync ingest and the
    projected-tag handler race in production, and the lookup-then-create
    without a lock minted the same message twice (observed live: one item,
    two FlowMessages, 0.4s apart). Placement is double-checked under the
    shared lock, so the pair must converge on ONE row."""

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_two_concurrent_projections_place_one_message(self):
        import asyncio
        import uuid

        from flow_sdk.builtin.data_source import DataSource
        from flow_sdk.builtin.flow_message import FlowMessage
        from flow_sdk.builtin.source_item import SourceItem
        from flow_sdk.inbox.projection import project_source_item

        source = DataSource(
            name="race", provider="telegram", channel="telegram",
            account_key=f"@bot-{uuid.uuid4().hex[:8]}",
        )
        await source.save()
        item = SourceItem(
            kind="content.message.chat", provider="telegram",
            data_source_id=str(source.id), segment_key="updates",
            external_id=f"1/{uuid.uuid4().hex[:8]}", thread_key="1",
            name="race", body="hello race",
            author_external_id="7", author_display="Someone",
        )
        await item.save()

        # `known_unplaced=True` on both mimics the worst case: each lane has
        # already "proved" there is no row before either inserted.
        results = await asyncio.gather(
            project_source_item(item, source=source, known_unplaced=True,
                                notify=False, recount=False, announce=False),
            project_source_item(item, source=source, known_unplaced=True,
                                notify=False, recount=False, announce=False),
        )
        assert all(r is not None for r in results)
        rows = await FlowMessage.get_all({"source_item_id": str(item.id)})
        assert len(rows) == 1, f"one item must place one message, got {len(rows)}"
        assert {r[0] for r in results} == {str(rows[0].id)}, "both lanes must converge on the same id"

    @pytest.mark.asyncio
    @pytest.mark.timeout(30)  # do not increase timeout without approval
    async def test_two_concurrent_projections_announce_once(self, monkeypatch):
        import asyncio
        import uuid

        from flow_sdk.builtin.data_source import DataSource
        from flow_sdk.builtin.source_item import SourceItem
        from flow_sdk.inbox.projection import project_source_item

        source = DataSource(
            name="race", provider="telegram", channel="telegram",
            account_key=f"@bot-{uuid.uuid4().hex[:8]}",
        )
        await source.save()
        item = SourceItem(
            kind="content.message.chat", provider="telegram",
            data_source_id=str(source.id), segment_key="updates",
            external_id=f"1/{uuid.uuid4().hex[:8]}", thread_key="1",
            name="race", body="hello race",
            author_external_id="7", author_display="Someone",
        )
        await item.save()
        projected = []
        monkeypatch.setattr(
            "flow_sdk.inbox.inbox_on_tag.emit_projected_tag",
            lambda projected_item: projected.append(str(projected_item.id)),
        )

        await asyncio.gather(
            project_source_item(item, source=source, known_unplaced=True,
                                notify=False, recount=False),
            project_source_item(item, source=source, known_unplaced=True,
                                notify=False, recount=False),
        )

        assert projected == [str(item.id)]


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


class TestPermalinkDerivation:
    """The connector supplies no link for Gmail, so the system derives one.

    Deliberately a FORMULA, never a model-composed string: `permalink` is a
    digested field, so a URL formatted differently on the next poll would
    rewrite the whole corpus.
    """

    def test_gmail_addresses_by_thread(self):
        from flow_sdk.ingest.drivers.channel_links import permalink_for

        assert permalink_for("gmail", "msg-1", "thread-9").endswith("#all/thread-9")

    def test_it_falls_back_to_the_message_id(self):
        from flow_sdk.ingest.drivers.channel_links import permalink_for

        assert permalink_for("gmail", "msg-1", "").endswith("#all/msg-1")

    def test_it_is_stable_across_calls(self):
        from flow_sdk.ingest.drivers.channel_links import permalink_for

        assert permalink_for("gmail", "m", "t") == permalink_for("gmail", "m", "t")

    def test_an_unknown_channel_yields_no_link(self):
        from flow_sdk.ingest.drivers.channel_links import permalink_for

        # Better an inert badge than a URL that 404s.
        assert permalink_for("slack", "m", "t") == ""
        assert permalink_for("gmail", "", "") == ""


class TestDisplayName:
    def test_a_name_is_extracted_from_the_rfc_form(self):
        from flow_sdk.inbox.projection import display_name_of

        assert display_name_of('"Ada Lovelace" <ada@x.io>', "ada@x.io") == "Ada Lovelace"
        assert display_name_of("Ada Lovelace <ada@x.io>", "ada@x.io") == "Ada Lovelace"

    def test_a_bare_address_stays_the_address(self):
        from flow_sdk.inbox.projection import display_name_of

        assert display_name_of("ada@x.io", "ada@x.io") == "ada@x.io"

    def test_an_empty_display_falls_back_to_the_address(self):
        from flow_sdk.inbox.projection import display_name_of

        # Never render an empty byline.
        assert display_name_of("", "ada@x.io") == "ada@x.io"


class TestSelfAddresses:
    def test_identities_and_the_legacy_account_key_both_count(self):
        from flow_sdk.inbox.projection import self_addresses

        source = SimpleNamespace(
            account_identities=["Me@Example.com", "alias@example.com"],
            account_key="gmail-primary",
        )
        assert self_addresses(source) == {"me@example.com", "alias@example.com", "gmail-primary"}

    def test_an_alias_maps_to_the_local_user_too(self):
        # One mailbox commonly answers to several addresses; mail I sent from
        # an alias is still mine.
        from flow_sdk.inbox.projection import self_addresses

        source = SimpleNamespace(account_identities=["a@x.io", "b@x.io"], account_key="")
        assert "b@x.io" in self_addresses(source)
