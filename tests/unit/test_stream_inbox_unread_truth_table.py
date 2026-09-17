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
        sender_id=row.get("sender_id"),
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
