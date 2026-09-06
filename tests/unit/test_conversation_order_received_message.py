"""A received message keeps its SEND position after the hub's delivery receipt.

Prod incident (conversation 38d20612): Gadi's question, sent 07:58Z, rendered
BELOW a reply written locally at 13:36Z, and its bubble read 13:39 — the moment
the delivery receipt was processed. ``project_pointers_to_entity`` documents
the two-clock rule this pins; the short version is that feed ORDER must read
``FlowMessage.occurred_at`` (the event clock) and never ``event_time``, whose
``updated_date`` fallback is a processing clock.

Why the receipt moves ``updated_date`` at all is the part worth stating here,
because it decides what the test may fake: a LOCAL ``save()`` cannot move it
(``apply_update_fields`` stamps it only when None). It moves because acking
delivery makes the HUB re-save its own row, so the next children-list sync
carries the hub's new ``updated_date`` and ``merge_hub_payload`` adopts it
under LWW. Hence the only stub here is the hub's HTTP response, carrying
exactly the wire shape a hub sends after an ack. Every local step — the
staleness gate, the LWW merge, the jsonl reconcile, the projection — is real.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import _fetch_conversation_messages
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.fs_store.operations.conversation import (
    default_jsonl_path,
    from_jsonl,
    project_pointers_to_entity,
)

_CONV_ID = "38d20612-8fe1-496c-9738-fc703150e0b4"
_QUESTION_ID = "a335eea0-c400-4baa-a08b-5085e1f1c6e4"
_REPLY_ID = "0e085c30-d0fe-4478-a87b-4cd38f0ebde4"

_SENT_AT = "2026-09-06T07:58:40.154216+00:00"       # hub-stamped: Gadi hit send
_REPLIED_AT = "2026-09-06T13:36:03.702078+00:00"    # our reply, 5h38m later
_RECEIVED_AT = "2026-09-06T13:39:52.135768+00:00"   # hub marks it received
_HUB_TOUCH = "2026-09-06T13:39:52.186917+00:00"     # the hub's save, 51ms later


def _question(**over) -> dict:
    base = {
        "id": _QUESTION_ID, "conversation_id": _CONV_ID,
        "text": "can you fix the application refresh button?",
        "sender_name": "Gadi Tunes", "sender_id": "gadi-user-id",
        "delivery_status": "sent",
        "created_date": _SENT_AT, "updated_date": _SENT_AT,
    }
    base.update(over)
    return base


def _reply() -> dict:
    return {
        "id": _REPLY_ID, "conversation_id": _CONV_ID,
        "text": "Fixed - it now does a full window reload.",
        "sender_name": "Eran Shlomo", "sender_id": "eran-user-id",
        "delivery_status": "sent",
        "created_date": _REPLIED_AT, "updated_date": _REPLIED_AT,
    }


async def _sync_from_hub(children: list[dict]) -> None:
    """One real children-list reconcile; only the HTTP response is stubbed."""
    with patch(
        "flow_sdk.app.actions.flow_message_action.hub_get",
        new=AsyncMock(return_value=children),
    ):
        assert await _fetch_conversation_messages(_CONV_ID, someone_typeid=None) is True


async def _project() -> Conversation:
    rec = from_jsonl(default_jsonl_path(_CONV_ID), parent_id="", record_id=_CONV_ID)
    await project_pointers_to_entity(rec, notify=False)
    return await Conversation.get_one({"id": _CONV_ID})


def _order(conv: Conversation) -> list[str]:
    return [p["typeid"].split("-", 1)[1] for p in json.loads(conv.message_ids or "[]")]


def _pointer_ts(conv: Conversation) -> dict[str, str]:
    return {p["typeid"].split("-", 1)[1]: p["ts"] for p in json.loads(conv.message_ids or "[]")}


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_delivery_receipt_does_not_move_a_received_message_past_our_reply():
    """CAPTURES BUG — the reply must never sort above the question it answers."""
    canonical = default_jsonl_path(_CONV_ID)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("")

    conv = Conversation.model_validate({"id": _CONV_ID, "title": "App refresh", "remote": True})
    conv.id = _CONV_ID
    await conv.save(None, notify=False)

    # 1. Both messages sync down, each carrying its own send time.
    await _sync_from_hub([_question(), _reply()])
    assert _order(await _project()) == [_QUESTION_ID, _REPLY_ID], \
        "precondition: on arrival the conversation reads in send order"

    # 2. We ack delivery. The hub marks the question received and re-saves its
    #    own row, so the next sync carries a hub updated_date of 13:39 — long
    #    after our 13:36 reply. Nothing local is forced; this is the wire shape.
    await _sync_from_hub([
        _question(delivery_status="received", received_at=_RECEIVED_AT, updated_date=_HUB_TOUCH),
        _reply(),
    ])

    question = await FlowMessage.get_one({"id": _QUESTION_ID})
    assert question.delivery_status == "received", "the receipt really landed"
    assert question.sent_at is None, "a received message carries no sent_at"
    assert Conversation._as_datetime(question.created_date) == Conversation._as_datetime(_SENT_AT), \
        "its send time is intact on the row — only the derived order is at stake"

    conv = await _project()

    assert _order(conv) == [_QUESTION_ID, _REPLY_ID], (
        "after the delivery receipt the question sorted BELOW the reply that "
        "answers it: event_time fell back to the hub's receipt-time "
        "updated_date instead of when the message was sent"
    )
    assert Conversation._as_datetime(_pointer_ts(conv)[_QUESTION_ID]) == \
        Conversation._as_datetime(_SENT_AT), (
        "the question's bubble time is the receipt clock, not its send time"
    )
