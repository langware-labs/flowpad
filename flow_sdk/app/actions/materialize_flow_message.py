"""Single write path for FlowMessage records.

Every producer (REST POST, hub-mirror sync, .flowmsg bundle unpack, draft
send, future email pull) goes through ``materialize_flow_message`` so that:

* the FlowMessage is saved before the conversation is notified,
* the typed Pointer is appended to the canonical ``conversation.jsonl``,
* ``Conversation.message_ids`` / ``message_count`` are projected via
  ``ConversationRecord.sync_to_db`` (never mutated by application code),
* WS sync is dispatched in load-bearing order: FM CREATE first, then
  Conversation UPDATE.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from flow_sdk._compat import UTC
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.discovery.notify import send_resource_sync
from flow_sdk.fs_records.conversation_record import ConversationRecord
from flow_sdk.fs_store import SyncOperation
from flow_sdk.fs_store.record_types import RecordType

logger = logging.getLogger(__name__)


async def ensure_conversation_entity(
    conversation_id: str,
    parent_typeid,
    *,
    project_id: Optional[str] = None,
    remote_project_id: Optional[str] = None,
    remote_project_name: Optional[str] = None,
    participants: Optional[list] = None,
    title: Optional[str] = None,
    someone_typeid: Optional[str] = None,
) -> Conversation:
    """Idempotent: return the local Conversation entity, creating it if missing.

    Also (re)creates the canonical ``conversation.jsonl`` and links the
    ConversationRecord to its parent record. Replaces the parallel
    ``_create_conversation_entity`` (sender) and ``_create_conversation_from_disk``
    (recipient) helpers — same behavior on both sides.

    ``parent_typeid`` may be a ``TypeId`` for the Task (preferred) or None when
    this conversation is project-scoped (uses ``project_id`` instead).

    ``remote_project_id`` / ``remote_project_name`` are the cross-machine
    identity of the *sender's* project. Stamped on receive so the per-machine
    remote→local mapping table can route future messages from the same remote
    project to the same local Project without re-prompting. Null on
    local-origin conversations.
    """
    conv = await Conversation.get_one({"id": conversation_id})
    title_clean = (title or "").strip() or None
    if conv is None:
        payload: dict = {"id": conversation_id}
        if project_id:
            payload["project_id"] = project_id
        if remote_project_id:
            payload["remote_project_id"] = remote_project_id
        if remote_project_name:
            payload["remote_project_name"] = remote_project_name
        if participants:
            payload["participants"] = list(participants)
        if title_clean:
            payload["title"] = title_clean
        if parent_typeid is not None:
            payload["context_entities"] = [str(parent_typeid)]
        conv = Conversation.model_validate(payload)
        conv.id = conversation_id
        conv = await conv.save(someone_typeid, notify=False)
    else:
        dirty = False
        if participants and not (conv.participants or []):
            # Backfill participants from the bundle so the reply-recipient
            # resolver can find the other party's email.
            conv.participants = list(participants)
            dirty = True
        if title_clean and not (conv.title or "").strip():
            # Backfill title on first receive — keep an existing local override.
            conv.title = title_clean
            dirty = True
        if dirty:
            conv = await conv.save(someone_typeid, notify=False)

    if parent_typeid is not None and parent_typeid.type == BuiltinEntityType.TASK.value:
        parent_id = parent_typeid.id
        parent_record_type = RecordType.TASK
    else:
        parent_id = project_id or ""
        parent_record_type = RecordType.PROJECT

    rec = ConversationRecord.from_jsonl(
        ConversationRecord.default_jsonl_path(conv.id),
        parent_id, conv.id, parent_type=parent_record_type,
    )
    rec.save()
    rec.link_to_parent_record()
    return conv


async def materialize_flow_message(
    payload: dict,
    conversation_id: str,
    *,
    someone_typeid: Optional[str],
    bundle_ts: Optional[str] = None,
    notify: bool = True,
    emit_live_create: bool = False,
) -> FlowMessage:
    """Create or upsert a FlowMessage, append its pointer to the conversation,
    project ``message_ids`` / ``message_count``, and (optionally) notify.

    Sequence (ordering is load-bearing — FM CREATE must precede Conversation
    UPDATE so the UI has the FM row to render when it refetches the
    conversation):

    1. Save the FlowMessage record (notify=False).
    2. Append a typed Pointer to the canonical ``conversation.jsonl``.
    3. ``ConversationRecord.sync_to_db`` projects ``message_ids`` /
       ``message_count`` onto the Conversation entity.
    4. If ``notify``: dispatch ``flow_message`` CREATE then ``conversation``
       UPDATE.

    ``payload`` is anything ``FlowMessage.model_validate`` accepts; ``id`` may
    be omitted (allocated) or pre-populated (idempotent upsert when the same
    id already exists).
    """
    payload = dict(payload)  # don't mutate caller's dict
    payload.setdefault("conversation_id", conversation_id)

    fm_id = payload.get("id")
    existing = await FlowMessage.get_one({"id": fm_id}) if fm_id else None
    is_new = existing is None
    if existing is not None:
        # Idempotent upsert — keep the row, ensure the pointer exists, return.
        fm = existing
    else:
        fm = FlowMessage.model_validate(payload)
        if not payload.get("id"):
            fm.id = FlowMessage.allocate_id(payload)
        # Save with notify=False — the CREATE is emitted explicitly below.
        # ``save()`` would emit an UPDATE here because ``model_validate``
        # carried the hub's ``created_by`` over (making ``exist_in_db``
        # True), and CREATE-only subscribers would never see it.
        fm = await fm.save(someone_typeid, notify=False)

    # Emit the explicit local CREATE that drives entity-event subscribers
    # (TS SDK ``conv.on('message')``).
    #
    # A brand-new row always emits. An *existing* row emits too when the
    # caller passes ``emit_live_create`` — that flag is the hub WS bridge
    # saying "this is a live arrival". Without it, a background catch-up
    # that materialized the row first would swallow the live create event
    # (the "doorbell rings once" bug): the second materialize was silent,
    # so body-bearing messages never reached the open conversation.
    if notify and (is_new or emit_live_create):
        from flow_sdk.api.messages import DataOpMessage, OperationType  # noqa: PLC0415
        from flow_sdk.core.network.resource_tracker import handle_entity_op  # noqa: PLC0415
        await handle_entity_op(
            DataOpMessage(data=fm, op=OperationType.CREATE, to_entity=fm.typeid)
        )

    # Resolve parent (Task preferred, else Project) for the record's parent_ref.
    conv = await Conversation.get_one({"id": conversation_id})
    if conv is None:
        # Caller didn't pre-create the conversation — build a bare one.
        conv = await ensure_conversation_entity(
            conversation_id, parent_typeid=None, someone_typeid=someone_typeid
        )

    parent_typeid = conv.first_context_of_type(BuiltinEntityType.TASK.value)
    if parent_typeid:
        parent_id = parent_typeid.id
        parent_type = RecordType.TASK
    else:
        parent_id = conv.project_id or ""
        parent_type = RecordType.PROJECT

    rec = ConversationRecord.from_jsonl(
        ConversationRecord.default_jsonl_path(conv.id),
        parent_id, conv.id, parent_type=parent_type,
    )

    ts = bundle_ts or datetime.now(UTC).isoformat()
    existing_ids = {p.id for p in rec.message_pointers()}
    if fm.id not in existing_ids:
        rec.append_message_pointer(fm.id, ts)
        await rec.sync_to_db(notify=False)

    if notify:
        try:
            task_id_for_sync = parent_id if parent_type == RecordType.TASK else fm.id
            # These are sniffer-channel NOTIFICATIONS that materialization
            # happened — not entity-reflection instructions. The real entity
            # events already fired: handle_entity_op for the FM CREATE above,
            # and conv.notify_updated() below. Sent as CRUD ops (CREATE/UPDATE)
            # they reached the webhook receiver's _reflect_entity, which tried
            # to *construct* a FlowMessage from this event-shaped payload —
            # which carries no entity fields — and failed with "text Field
            # required". EVENT routes to the event handler / sniffer instead,
            # which is all this channel was ever for.
            send_resource_sync(
                type="flow_message",
                id=fm.id,
                operation=SyncOperation.EVENT,
                data={
                    "event_name": "flow_message_materialized",
                    "event_data": {"flow_message_id": fm.id, "task_id": task_id_for_sync},
                },
            )
            send_resource_sync(
                type="conversation",
                id=conv.id,
                operation=SyncOperation.EVENT,
                data={
                    "event_name": "conversation_updated",
                    "event_data": {"task_id": task_id_for_sync, "conversation_id": conv.id},
                },
            )
            # Entity-event channel — required for React useEntity hooks to
            # re-render. send_resource_sync only fires the sniffer channel.
            conv_fresh = await Conversation.get_one({"id": conv.id})
            if conv_fresh:
                await conv_fresh.notify_updated()
        except Exception as e:  # noqa: BLE001
            logger.warning("[materialize_flow_message] notify failed: %s", e)

    return fm
