"""The composer's draft: a whole message that only this machine holds, until Send moves the SAME
row into the conversation."""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import AttachmentType, DeliveryStatus, FlowMessage
from flow_sdk.fs_store.record_paths import get_default_records_root
from flow_sdk.storage import get_entity_embedded_storage
from tests.api.test_add_message_prompt_entity import _make_conversation

pytestmark = pytest.mark.asyncio


async def _put(client, conv_id, data, files=None):
    resp = await client.post(f"/api/v1/graph/conversation/{conv_id}/draft", data=data, files=files)
    assert resp.json().get("status") == "SUCCESS", resp.text
    return resp.json()["data"]["draft"]


def _file_names(fm):
    return sorted(a.data.rsplit("/", 1)[-1] for a in fm.attachment or [] if a.attachment_type == AttachmentType.FILE)


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_draft_is_one_row_that_edits_in_place_and_leaves_no_trace_when_emptied(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)

    first = await _put(client, conv_id, {"text": "hel"}, files=[("files", ("a.txt", b"A", "text/plain"))])
    again = await _put(
        client, conv_id, {"text": "hello ", "file_names": '["a.txt"]', "task": "true"},
        files=[("files", ("b.txt", b"B", "text/plain"))],
    )
    assert again["id"] == first["id"]
    fm = await FlowMessage.find_composer_draft(conv_id)
    assert (fm.text, fm.is_draft, fm.draft_options.task, _file_names(fm)) == ("hello ", True, True, ["a.txt", "b.txt"])
    # Its own composer only: a thread's draft is another row.
    in_thread = await _put(client, conv_id, {"text": "aside", "thread_id": "t1"})
    assert in_thread["id"] != first["id"]

    # Not in the conversation: no pointer, no count, not among its messages, not owed to the hub.
    conv = await Conversation.get_one({"id": conv_id})
    assert conv.message_count == 0 and await conv.messages() == []
    assert not fm.owes_delivery and not fm.written_here

    kept = await _put(client, conv_id, {"text": "hello", "file_names": '["b.txt"]'})
    storage = get_entity_embedded_storage(fm.typeid)
    assert _file_names(await FlowMessage.get_one({"id": kept["id"]})) == ["b.txt"]
    assert not Path(storage.get_storage_path("data/a.txt")).exists()

    assert await _put(client, conv_id, {"text": "  "}) is None
    assert await FlowMessage.get_one({"id": first["id"]}) is None
    assert not Path(storage.get_storage_path("data/b.txt")).exists()
    assert not (get_default_records_root() / "flow_message" / first["id"]).exists()


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_send_moves_the_same_row_into_the_conversation(bootstrapped_client, user):
    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    draft = await _put(client, conv_id, {"text": "ship it"}, files=[("files", ("a.txt", b"A", "text/plain"))])

    resp = await client.post(f"/api/v1/graph/flow_message/{draft['id']}/send-draft", json={})
    assert resp.json().get("status") == "SUCCESS", resp.text

    fm = await FlowMessage.get_one({"id": draft["id"]})
    assert not fm.is_draft and fm.draft_options is None and fm.written_here
    assert fm.delivery_status in (DeliveryStatus.PENDING_SEND.value, DeliveryStatus.CREATED.value, DeliveryStatus.SENT.value)
    assert _file_names(fm) == ["a.txt"]
    conv = await Conversation.get_one({"id": conv_id})
    assert [m.id for m in await conv.messages()] == [draft["id"]] and conv.message_count == 1
    assert await FlowMessage.find_composer_draft(conv_id) is None
    # Sent once: a second Send of the same row is refused.
    again = await client.post(f"/api/v1/graph/flow_message/{draft['id']}/send-draft", json={})
    assert again.json().get("status") != "SUCCESS"


@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_drafted_session_prompt_is_sent_by_the_same_action(bootstrapped_client, user):
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession

    client = bootstrapped_client
    conv_id = await _make_conversation(client)
    resp = await client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"message": "", "prompt_text": "list the files", "is_draft": True},
    )
    fm_id = resp.json()["data"]["flow_message_id"]
    # A session's draft is not the composer's: typing in the composer never touches it.
    assert await FlowMessage.find_composer_draft(conv_id) is None

    sent = await client.post(f"/api/v1/graph/flow_message/{fm_id}/send-draft", json={})
    assert sent.json().get("status") == "SUCCESS", sent.text
    fm = await FlowMessage.get_one({"id": fm_id})
    assert not fm.is_draft and fm.written_here
    assert sum(1 for a in fm.attachment or [] if str(a.data) == f"remote_worker_session-{fm.remote_worker_session_id}") == 1
    assert (await RemoteWorkerSession.get_one({"id": fm.remote_worker_session_id})).status == "pending"
    assert [m.id for m in await (await Conversation.get_one({"id": conv_id})).messages()] == [fm_id]
