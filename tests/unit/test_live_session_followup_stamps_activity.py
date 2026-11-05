"""A follow-up prompt in an open live session moves the session's activity clock.

The footer Live chip pulses blue ("sent") only when ``last_activity_at`` moves.
Before the fix, only the first (DRAFT) prompt stamped it on the guest, so every
later send left the clock still and the chip never glowed blue.
Drives the real send handler on a local conversation; nothing is mocked.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.app.actions.notification_action import handle_add_message
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession, RemoteWorkerSessionStatus
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)

OLD_CLOCK = "2026-01-01T00:00:00+00:00"


@pytest.fixture
def records_root(tmp_path):
    orig_root, orig_data = get_default_records_root(), get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    try:
        yield tmp_path
    finally:
        set_default_records_root(orig_root)
        set_default_records_data_root(orig_data)


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_followup_prompt_advances_clock_and_reads_as_sent(records_root):
    conv = Conversation.model_validate({"id": str(uuid.uuid4()), "remote": False})
    await conv.save(None)
    session = RemoteWorkerSession(
        conversation_id=conv.id,
        status=RemoteWorkerSessionStatus.IDLE,
        last_activity_at=OLD_CLOCK,
    )
    await session.save(None)

    await handle_add_message(
        {
            "conversation_id": conv.id,
            "message": "next step",
            "prompt_text": "do the next step",
            "remote_worker_session_id": session.id,
        },
        f"user-{uuid.uuid4()}",
    )

    after = await RemoteWorkerSession.get_one({"id": session.id})
    assert after.last_activity_at > OLD_CLOCK
    # RUNNING is what the chip reads as "a prompt went out" (blue).
    assert after.status == RemoteWorkerSessionStatus.RUNNING
