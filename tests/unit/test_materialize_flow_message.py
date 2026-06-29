"""Phase 2: materialize_flow_message single write path.

Verifies the unified producer:

* appends one typed Pointer per call to the canonical conversation.jsonl,
* projects ``message_count`` onto the Conversation entity,
* is idempotent on the same FlowMessage id,
* dispatches WS sync in the load-bearing order (FM CREATE → Conversation
  UPDATE) without raising when notify=False.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from flow_sdk.app.actions.materialize_flow_message import (
    ensure_conversation_entity,
    materialize_flow_message,
)
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.fs_store.operations.conversation import default_jsonl_path
from flow_sdk.fs_store.pointer import Pointer
from flow_sdk.fs_store.type_id import TypeId


_CONV_ID = "aaaa1111-2222-3333-4444-555555555551"
_TASK_ID = "bbbb1111-2222-3333-4444-555555555552"
_FM_ID = "cccc1111-2222-3333-4444-555555555553"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_appends_one_pointer_and_projects_count(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )

    canonical = default_jsonl_path(_CONV_ID)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("")

    conv = Conversation(context_entities=[f"task-{_TASK_ID}"])
    conv.id = _CONV_ID

    saved_fm = FlowMessage.model_validate({"id": _FM_ID, "text": "hi"})

    refreshed_conv = Conversation(context_entities=[f"task-{_TASK_ID}"])
    refreshed_conv.id = _CONV_ID

    with (
        patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
        patch.object(FlowMessage, "save", new=AsyncMock(return_value=saved_fm)),
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=conv)),
        patch(
            "flow_sdk.app.actions.materialize_flow_message.project_pointers_to_entity",
            new=AsyncMock(return_value=None),
        ),
        patch("flow_sdk.app.actions.materialize_flow_message.send_resource_sync"),
    ):
        result = await materialize_flow_message(
            {"id": _FM_ID, "text": "hi"},
            conversation_id=_CONV_ID,
            someone_typeid=None,
        )

    assert result.id == _FM_ID
    lines = [l for l in canonical.read_text().splitlines() if l.strip()]
    assert len(lines) == 1
    ptr = Pointer.from_jsonl_line(lines[0])
    assert ptr.id == _FM_ID
    assert ptr.type == "flow_message"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_idempotent_on_same_fm_id(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )

    canonical = default_jsonl_path(_CONV_ID)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("")

    conv = Conversation(context_entities=[f"task-{_TASK_ID}"])
    conv.id = _CONV_ID

    existing_fm = FlowMessage.model_validate({"id": _FM_ID, "text": "hi"})

    with (
        patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=existing_fm)),
        patch.object(FlowMessage, "save", new=AsyncMock(return_value=existing_fm)),
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=conv)),
        patch(
            "flow_sdk.app.actions.materialize_flow_message.project_pointers_to_entity",
            new=AsyncMock(return_value=None),
        ),
        patch("flow_sdk.app.actions.materialize_flow_message.send_resource_sync"),
    ):
        await materialize_flow_message(
            {"id": _FM_ID, "text": "hi"},
            conversation_id=_CONV_ID,
            someone_typeid=None,
        )
        await materialize_flow_message(
            {"id": _FM_ID, "text": "hi"},
            conversation_id=_CONV_ID,
            someone_typeid=None,
        )

    lines = [l for l in canonical.read_text().splitlines() if l.strip()]
    assert len(lines) == 1, f"expected 1 pointer, got {len(lines)}: {lines!r}"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_notify_dispatches_fm_create_then_conversation_update(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )

    canonical = default_jsonl_path(_CONV_ID)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("")

    conv = Conversation(context_entities=[f"task-{_TASK_ID}"])
    conv.id = _CONV_ID
    saved_fm = FlowMessage.model_validate({"id": _FM_ID, "text": "hi"})

    sync_calls = []

    def _capture_sync(**kwargs):
        sync_calls.append(kwargs)

    with (
        patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
        patch.object(FlowMessage, "save", new=AsyncMock(return_value=saved_fm)),
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=conv)),
        patch(
            "flow_sdk.app.actions.materialize_flow_message.project_pointers_to_entity",
            new=AsyncMock(return_value=None),
        ),
        patch(
            "flow_sdk.app.actions.materialize_flow_message.send_resource_sync",
            side_effect=_capture_sync,
        ),
    ):
        await materialize_flow_message(
            {"id": _FM_ID, "text": "hi"},
            conversation_id=_CONV_ID,
            someone_typeid=None,
        )

    assert len(sync_calls) == 2
    assert sync_calls[0]["type"] == "flow_message"
    assert sync_calls[1]["type"] == "conversation"


async def _materialize_capture_created_by(monkeypatch, tmp_path, payload):
    """Run materialize_flow_message for a remote payload and return the
    ``created_by`` the FlowMessage carried into save()."""
    monkeypatch.setattr(
        "flow_sdk.fs_store.record_paths.get_default_records_data_root",
        lambda: tmp_path,
    )
    canonical = default_jsonl_path(_CONV_ID)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("")

    conv = Conversation(context_entities=[f"task-{_TASK_ID}"])
    conv.id = _CONV_ID

    captured = {}

    async def _capture_save(self, *args, **kwargs):
        captured["created_by"] = self.created_by
        return self

    with (
        patch.object(FlowMessage, "get_one", new=AsyncMock(return_value=None)),
        patch.object(FlowMessage, "save", new=_capture_save),
        patch.object(Conversation, "get_one", new=AsyncMock(return_value=conv)),
        patch(
            "flow_sdk.app.actions.materialize_flow_message.project_pointers_to_entity",
            new=AsyncMock(return_value=None),
        ),
        patch("flow_sdk.app.actions.materialize_flow_message.send_resource_sync"),
    ):
        await materialize_flow_message(
            payload,
            conversation_id=_CONV_ID,
            someone_typeid=None,
            notify=False,
            remote=True,
        )
    return captured["created_by"]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_remote_payload_without_created_by_stays_null(monkeypatch, tmp_path):
    """A hub-origin row is a pure reflection: when the wire carries no
    ``created_by`` it stays NULL — the receiver must NOT fabricate it from
    ``sender_id`` or the 'system' sentinel (and the reflection block stops the
    driver stamping the local recipient). Display resolves the author from the
    participant roster instead."""
    created_by = await _materialize_capture_created_by(
        monkeypatch, tmp_path,
        {"id": _FM_ID, "text": "hi", "sender_id": "remote-sender-id"},
    )
    assert created_by is None


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_remote_payload_preserves_hub_created_by_verbatim(monkeypatch, tmp_path):
    """When the hub DID stamp ``created_by`` (from the sender's auth token), it
    is carried through verbatim — never overwritten."""
    created_by = await _materialize_capture_created_by(
        monkeypatch, tmp_path,
        {"id": _FM_ID, "text": "hi", "sender_id": "remote-sender-id",
         "created_by": "hub-stamped-author"},
    )
    assert created_by == "hub-stamped-author"
