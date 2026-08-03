""""Latest message" means newest by timestamp, not last appended.

``message_ids`` is append-ordered and appends are arrival-ordered. Those agree
only while messages arrive in the order they were sent — which stops being true
the moment anything backfills. An ingested mailbox hands its history back
newest-first, so the LAST pointer is the OLDEST mail, and reading ``refs[-1]``
corrupts the unread count, the inbox preview and the archive auto-revive
comparison at once.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from flow_sdk.builtin.conversation import Conversation

BASE = datetime(2026, 7, 31, 12, 0, tzinfo=timezone.utc)


def _conv(*pointers: tuple[str, str | None], **fields) -> Conversation:
    """A conversation whose projection carries `(id, ts)` pointers verbatim."""
    entries = [
        {"typeid": f"flow_message-@{mid}", **({"ts": ts} if ts is not None else {})}
        for mid, ts in pointers
    ]
    conv = Conversation(id="c-1", **fields)
    conv._set_projection(  # noqa: SLF001 — the sanctioned projection writer
        "message_ids", json.dumps(entries),
        __import__("flow_sdk.builtin.conversation", fromlist=["x"])._PROJECTION_SENTINEL,
    )
    return conv


def _iso(minutes: int) -> str:
    return (BASE + timedelta(minutes=minutes)).isoformat()


class TestLatestMessageRef:
    def test_in_order_arrival_still_picks_the_last(self):
        conv = _conv(("a", _iso(0)), ("b", _iso(1)), ("c", _iso(2)))
        assert conv.latest_message_ref().id == "c"

    def test_a_newest_first_backfill_does_not_pick_the_oldest(self):
        # THE regression. Ingested mail arrives newest-first, so the last
        # pointer is the oldest message.
        conv = _conv(("newest", _iso(10)), ("middle", _iso(5)), ("oldest", _iso(0)))
        assert conv.latest_message_ref().id == "newest"

    def test_a_late_arriving_old_message_does_not_become_latest(self):
        conv = _conv(("a", _iso(0)), ("newest", _iso(10)), ("late_but_old", _iso(1)))
        assert conv.latest_message_ref().id == "newest"

    def test_an_empty_conversation_has_no_latest(self):
        assert _conv().latest_message_ref() is None

    def test_a_missing_timestamp_never_wins(self):
        # A corrupt/absent ts must not be treated as "now" and hijack the row.
        conv = _conv(("real", _iso(5)), ("no_ts", None))
        assert conv.latest_message_ref().id == "real"

    def test_all_timestamps_missing_is_not_an_error(self):
        assert _conv(("a", None), ("b", None)).latest_message_ref() is not None

    def test_naive_and_aware_timestamps_do_not_raise(self):
        # Both shapes appear in real projections; comparing them directly is a
        # TypeError inside max().
        conv = _conv(("naive", "2026-07-31T12:00:00"), ("aware", _iso(60)))
        assert conv.latest_message_ref().id == "aware"


class TestArchiveRevive:
    """`is_archived` reads the same "latest" — a backfill must not revive a
    conversation just because an OLD message landed last."""

    def test_an_old_backfilled_message_does_not_revive_an_archive(self):
        conv = _conv(("new", _iso(0)), ("old", _iso(-1000)),
                     archived_at=BASE + timedelta(minutes=5))
        assert conv.is_archived() is True

    def test_genuinely_newer_activity_still_revives(self):
        conv = _conv(("old", _iso(0)), ("new", _iso(60)),
                     archived_at=BASE + timedelta(minutes=5))
        assert conv.is_archived() is False


class TestUnreadUsesTheSameLatest:
    def test_a_backfill_counts_the_newest_message_not_the_last(self):
        from flow_sdk.inbox import count_unread

        conv = _conv(("newest", _iso(10)), ("oldest", _iso(0)))
        messages = {
            "newest": _fm("newest", is_read=False),
            "oldest": _fm("oldest", is_read=True),
        }
        # Reading `refs[-1]` would find the READ oldest message and count 0.
        assert count_unread(
            conversations=[conv], fm_by_id=messages, invitations=[],
            self_ids=set(), viewer_email=None, now=BASE,
        ) == 1


def _fm(mid: str, *, is_read: bool):
    from types import SimpleNamespace

    return SimpleNamespace(id=mid, is_read=is_read, sender_id="gmail:x@y.z",
                           is_draft=False)
