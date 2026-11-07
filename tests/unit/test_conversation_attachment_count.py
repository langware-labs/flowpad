"""``Conversation.attachment_count`` — the inbox row's paperclip — counts the files across a
conversation, moves when a file arrives later, and is filled for rows that predate it.

Only the hub's HTTP response is stubbed; the sync, the projection and the saves are real.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions.flow_message_action import _fetch_conversation_messages
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.cloud_client.hub_proxy import HubProxy
from flow_sdk.fs_store.operations.conversation import default_jsonl_path, from_jsonl, project_pointers_to_entity
from flow_sdk.migrations import migration_2026_11_attachment_count

FILE = {"attachment_type": "file", "data": "files/report.pdf"}
PROMPT_FILE = {"attachment_type": "prompt", "data": "prompt/brief.md"}
INLINE_PROMPT = {"attachment_type": "prompt", "data": "just text"}
ENTITY = {"attachment_type": "type_id", "data": f"task-{uuid.uuid4()}"}


def _msg(conv_id: str, at: str, attachment: list[dict]) -> dict:
    return {
        "id": str(uuid.uuid4()), "conversation_id": conv_id, "text": "hi", "sender_name": "alice",
        "sender_id": "alice-user-id", "delivery_status": "sent", "created_date": at, "updated_date": at,
        "attachment": attachment,
    }


async def _new_conversation() -> str:
    conv_id = str(uuid.uuid4())
    path = default_jsonl_path(conv_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("")
    conv = Conversation.model_validate({"id": conv_id, "title": "files", "remote": True})
    conv.id = conv_id
    await conv.save(None, notify=False)
    return conv_id


async def _arrive(conv_id: str, children: list[dict]) -> Conversation:
    with patch.object(HubProxy, "call", new=AsyncMock(return_value=children)):
        assert await _fetch_conversation_messages(conv_id, someone_typeid=None) is True
    await project_pointers_to_entity(from_jsonl(default_jsonl_path(conv_id), parent_id="", record_id=conv_id), notify=False)
    return await Conversation.get_one({"id": conv_id})


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_files_are_counted_and_a_file_sent_later_moves_the_count():
    conv_id = await _new_conversation()
    first = [_msg(conv_id, "2026-11-01T08:00:00+00:00", [FILE, ENTITY, INLINE_PROMPT])]
    assert (await _arrive(conv_id, first)).attachment_count == 1, "only the FILE is a listed attachment"

    plain = first + [_msg(conv_id, "2026-11-01T08:01:00+00:00", [])]
    assert (await _arrive(conv_id, plain)).attachment_count == 1, "a message with no files changes nothing"

    later = plain + [_msg(conv_id, "2026-11-02T08:00:00+00:00", [FILE, PROMPT_FILE])]
    assert (await _arrive(conv_id, later)).attachment_count == 3, "a file sent later is counted"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_boot_lift_fills_rows_that_predate_the_field_once():
    from flow_sdk.db.drivers.db_driver import _driver_instances
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    conv_id = await _new_conversation()
    await _arrive(conv_id, [_msg(conv_id, "2026-11-01T08:00:00+00:00", [FILE, PROMPT_FILE])])
    db_path = _driver_instances["sqlite"].config.database
    conn = open_sqlite(db_path)
    try:  # the row as an older build wrote it: no attachment_count key at all
        conn.execute("UPDATE entities SET data = json_remove(data, '$.attachment_count') WHERE id = ?", (conv_id,))
        conn.commit()
    finally:
        conn.close()

    assert (await migration_2026_11_attachment_count.lift(dry_run=False, db_path=db_path)).moved
    assert (await Conversation.get_one({"id": conv_id})).attachment_count == 2
    assert (await migration_2026_11_attachment_count.lift(dry_run=False, db_path=db_path)).moved == [], "a second boot is a no-op"
