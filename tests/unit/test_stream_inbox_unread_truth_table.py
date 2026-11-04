"""Truth-table test for the stream inbox unread rule (``flow_sdk.stream_inbox.project_unread``).

Table-driven over the SHARED fixture ``tests/fixtures/stream_inbox_unread_truth_table.json``.
The backend owns unread: this pins both the badge count (``expected``) and each
conversation's ``is_unread`` flag (``facets.isUnread``) from one rule, and the frontend
vitest over the same file pins that rows render that flag instead of recomputing it.
Pure: plain namespaces in, a projection out; no DB, no mocks.
"""

import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.data_spec.message_sender_spec import MessageSender
from flow_sdk.stream_inbox import project_unread

FIXTURE = Path(__file__).parent.parent / "fixtures" / "stream_inbox_unread_truth_table.json"
TABLE = json.loads(FIXTURE.read_text())


def _dt(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None


def _conversation(row: dict) -> Conversation:
    # The REAL entity, no DB — message-ref parsing (message_refs) and the
    # archive auto-revive rule (is_archived) are Conversation behavior, so the
    # truth table exercises them where they live.
    pointers = [
        {"typeid": f"flow_message-{p['fm']}", "ts": p["ts"]} for p in row.get("pointers", [])
    ]
    return Conversation(
        id=row["id"],
        owner=TypeId(row["owner"]) if row.get("owner") else None,
        archived_at=_dt(row.get("archived_at")),
        message_ids=json.dumps(pointers) if pointers else None,
    )


def _message(mid: str, row: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id=mid,
        is_read=bool(row.get("is_read")),
        sender=MessageSender.from_wire(row.get("sender_id") or ""),
        is_draft=bool(row.get("is_draft")),
        kind=row.get("kind", "user"),
    )


def _invitation(row: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id=row["id"],
        accepted=row.get("accepted"),
        recipient_email=row.get("recipient_email"),
        expiration_at=_dt(row.get("expiration_at")),
        target_url_path=row.get("target_url_path"),
        target_type=row.get("target_type"),
        target_id=row.get("target_id"),
    )


@pytest.mark.parametrize("case", TABLE["cases"], ids=[c["name"] for c in TABLE["cases"]])
def test_unread_truth_table(case):
    viewer = TABLE["viewer"]
    projection = project_unread(
        conversations=[_conversation(c) for c in case["conversations"]],
        fm_by_id={mid: _message(mid, m) for mid, m in case["messages"].items()},
        invitations=[_invitation(i) for i in case["invitations"]],
        self_ids={viewer["cloud_user_id"], viewer["local_user_id"]},
        viewer_email=viewer["email"],
        now=_dt(TABLE["now"]),
        stream_inbox_owner=TypeId(case["stream_inbox_owner"]) if case.get("stream_inbox_owner") else None,
    )
    assert projection.total == case["expected"], case["name"]
    facets = case.get("facets")
    if facets:
        assert projection.by_conversation[facets["conversation"]] is facets["isUnread"], case["name"]
        # The per-conversation COUNT (a Vibe help task's badge) — > 0 exactly when the flag is set.
        assert projection.counts[facets["conversation"]] == facets["unreadCount"], case["name"]
        assert (projection.counts[facets["conversation"]] > 0) is facets["isUnread"], case["name"]


def _project(case, fm_by_id):
    viewer = TABLE["viewer"]
    return project_unread(
        conversations=[_conversation(c) for c in case["conversations"]],
        fm_by_id=fm_by_id,
        invitations=[_invitation(i) for i in case["invitations"]],
        self_ids={viewer["cloud_user_id"], viewer["local_user_id"]},
        viewer_email=viewer["email"],
        now=_dt(TABLE["now"]),
        stream_inbox_owner=TypeId(case["stream_inbox_owner"]) if case.get("stream_inbox_owner") else None,
    )


def _reader(messages: dict):
    """``fetch(ids)`` over a dict, recording every id asked for."""
    asked: list = []

    async def fetch(ids):
        asked.extend(ids)
        return [messages[i] for i in ids if i in messages]

    return fetch, asked


@pytest.mark.parametrize("case", TABLE["cases"], ids=[c["name"] for c in TABLE["cases"]])
async def test_reading_only_what_the_rule_walks_projects_the_same(case):
    # The recompute no longer loads every message: it reads, window by window, the ones the rule
    # walks. Over every truth-table case the projection must be the one the full load gives.
    from flow_sdk.stream_inbox import _messages_the_formula_reads

    viewer = TABLE["viewer"]
    messages = {mid: _message(mid, m) for mid, m in case["messages"].items()}
    fetch, _asked = _reader(messages)
    read = await _messages_the_formula_reads(
        [_conversation(c) for c in case["conversations"]], {viewer["cloud_user_id"], viewer["local_user_id"]}, fetch
    )
    full, lazy = _project(case, messages), _project(case, read)
    assert (lazy.total, lazy.by_conversation, lazy.counts) == (full.total, full.by_conversation, full.counts), case["name"]


async def test_a_read_conversation_costs_one_message_and_an_unread_streak_only_its_length():
    from flow_sdk.stream_inbox import _messages_the_formula_reads

    them = "user-00000000-0000-4000-8000-0000000000aa"
    pointers = lambda prefix, n: [{"fm": f"{prefix}{i}", "ts": f"2026-01-01T00:{i:02d}:00Z"} for i in range(n)]  # noqa: E731
    quiet = _conversation({"id": "quiet", "pointers": pointers("q", 40)})
    streak = _conversation({"id": "streak", "pointers": pointers("s", 40)})
    messages = {f"q{i}": _message(f"q{i}", {"is_read": True, "sender_id": them}) for i in range(40)}
    # The 5 newest of "streak" are unread, the rest read.
    messages.update({f"s{i}": _message(f"s{i}", {"is_read": i < 35, "sender_id": them}) for i in range(40)})
    fetch, asked = _reader(messages)
    read = await _messages_the_formula_reads([quiet, streak], {"user-self"}, fetch)
    assert [i for i in asked if i.startswith("q")] == ["q39"], "a read conversation: its newest message only"
    assert {i for i in asked if i.startswith("s")} >= {f"s{i}" for i in range(34, 40)}, "the streak and the read one ending it"
    assert len([i for i in asked if i.startswith("s")]) <= 8, "windows of 1, 2, 4: never the whole conversation"
    assert len(read) < len(messages)
