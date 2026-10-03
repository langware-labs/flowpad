"""A consumed session prompt is never handed back to the drain by a stale save.

QC 2026-10-01 (hub_playwright ``live_session_stress``): 11 prompts, 12 replies —
one follow-up ran twice on the host. Instrumented on bob, the second run was
preceded by a write of ``prompt_auto_handled`` True→False from the conversation
catch-up (``conversation_message_sync`` → ``_fetch_conversation_messages`` →
``_process_single_hub_message`` → ``fm.save()``). That writer reads the row,
awaits the hub (body download), then saves ``merge_hub_payload(existing, raw)``
— which restores the local-only marker from its OWN copy, read before the turn
consumed the prompt. The save rolled the consume back and the session drain
(``_queued_turns``) selected the prompt again.

Only the hub's body download is stubbed (it is the await the consume lands in);
the catch-up writer, the consume and the queue selection are real.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import patch

import pytest

from flow_sdk.app.actions.execute_prompt import _queued_turns, consume_prompt, release_prompt
from flow_sdk.app.actions.flow_message_action import _process_single_hub_message
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage

pytestmark = pytest.mark.asyncio

GUEST = "guest-cloud-user-id"
HOST = str(uuid.uuid4())
HOST_TYPEID = f"user-{HOST}"


def _prompt_row(conv_id: str, session_id: str) -> dict:
    return {
        "id": str(uuid.uuid4()),
        "conversation_id": conv_id,
        "remote_worker_session_id": session_id,
        "text": "Please run the following prompt:",
        "sender_id": GUEST,
        "sender_name": "alice",
        "delivery_status": "sent",
        "body_status": "ready",
        "attachment_filename": "body.flowmsg",
        "attachment": [
            {"attachment_type": AttachmentType.TYPE_ID.value, "data": f"prompt-{uuid.uuid4()}"},
        ],
        "created_date": "2026-10-01T08:00:00+00:00",
        "updated_date": "2026-10-01T08:00:00+00:00",
    }


async def _arrived_prompt() -> tuple[SimpleNamespace, dict]:
    conv_id, session_id = str(uuid.uuid4()), str(uuid.uuid4())
    row = _prompt_row(conv_id, session_id)
    fm = FlowMessage.model_validate({**row, "remote": True})
    await fm.save(None, notify=False)
    session = SimpleNamespace(id=session_id, conversation_id=conv_id)
    assert [m.id for m in await _queued_turns(session, HOST)] == [row["id"]], "precondition: the prompt is queued"
    return session, row


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_catch_up_refresh_does_not_unconsume_a_running_prompt():
    """CAPTURES BUG — the turn consumes the prompt while the catch-up awaits the hub."""
    session, row = await _arrived_prompt()

    async def turn_consumes_meanwhile(*_a, **_kw) -> bool:
        fresh = await FlowMessage.get_one({"id": row["id"]})
        await consume_prompt(fresh, HOST_TYPEID)
        return False  # body not pulled → the catch-up falls through to its LWW refresh

    hub_row = {**row, "delivery_status": "delivered", "updated_date": "2026-10-01T08:00:09+00:00"}
    with patch(
        "flow_sdk.app.actions.flow_message_action._download_and_unpack_bundle",
        new=turn_consumes_meanwhile,
    ):
        assert await _process_single_hub_message(hub_row) == row["id"]

    stored = await FlowMessage.get_one({"id": row["id"]})
    assert stored.delivery_status == "delivered", "precondition: the catch-up's own refresh landed"
    assert stored.prompt_auto_handled is True, (
        "the catch-up saved its pre-consume copy and rolled prompt_auto_handled back"
    )
    assert await _queued_turns(session, HOST) == [], "the drain re-selected a prompt whose turn already ran"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_release_prompt_still_hands_a_dead_turn_back():
    """Crash recovery's release is the one writer allowed to clear the marker."""
    session, row = await _arrived_prompt()
    fm = await FlowMessage.get_one({"id": row["id"]})
    await consume_prompt(fm, HOST_TYPEID)
    assert await _queued_turns(session, HOST) == []

    await release_prompt(await FlowMessage.get_one({"id": row["id"]}), HOST_TYPEID)

    assert (await FlowMessage.get_one({"id": row["id"]})).prompt_auto_handled is False
    assert [m.id for m in await _queued_turns(session, HOST)] == [row["id"]]
