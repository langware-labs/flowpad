"""Conversation operations — free functions over FSRecord(type='conversation').

Conversation layout::

    <records_data_root>/conversation/conversation-@<id>/conversation.jsonl

Each line in the jsonl is a typed ``Pointer`` to a FlowMessage record.

Surface (all free functions, no class):
- ``default_data_dir(record_id)`` / ``default_jsonl_path(record_id)``
- ``message_pointers(rec)`` / ``append_message_pointer(rec, mid, ts)``
- ``append_pointer(rec, p)`` / ``write_pointers(rec, ptrs)``
- ``from_jsonl(jsonl_path, parent_id, record_id, *, parent_type)``
- ``project_pointers_to_entity(rec, notify)``
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store import Pointer
from flow_sdk.fs_store.fs_record import FSRecord, write_text_if_changed
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.type_id import TypeId


def default_data_dir(record_id: str) -> Path:
    if not record_id:
        raise ValueError("record_id is required")
    from flow_sdk.fs_store.record_paths import data_dir_for

    return data_dir_for(RecordType.CONVERSATION, record_id)


def default_jsonl_path(record_id: str) -> Path:
    return default_data_dir(record_id) / "conversation.jsonl"


def _jsonl_path_for(rec: FSRecord) -> Path | None:
    rid = rec.id
    return default_jsonl_path(rid) if rid else None


def message_pointers(rec: FSRecord) -> list[Pointer]:
    path = _jsonl_path_for(rec)
    if not path or not path.exists():
        return []
    out: list[Pointer] = []
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(Pointer.from_jsonl_line(line))
            except Exception:
                continue
    except Exception:
        pass
    return out


def append_message_pointer(rec: FSRecord, message_id: str, timestamp: str) -> Pointer:
    """Append a pointer line for a FlowMessage and return the Pointer."""
    path = _jsonl_path_for(rec)
    if not path:
        raise ValueError("FSRecord has no id; cannot resolve jsonl path")
    path.parent.mkdir(parents=True, exist_ok=True)
    ptr = Pointer(TypeId(type=Pointer.DEFAULT_MESSAGE_TYPE, id=message_id), timestamp)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(ptr.to_jsonl_line() + "\n")
    return ptr


def append_pointer(rec: FSRecord, pointer: Pointer) -> None:
    path = _jsonl_path_for(rec)
    if not path:
        raise ValueError("FSRecord has no id; cannot resolve jsonl path")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(pointer.to_jsonl_line() + "\n")


def write_pointers(rec: FSRecord, pointers: list[Pointer]) -> None:
    path = _jsonl_path_for(rec)
    if not path:
        raise ValueError("FSRecord has no id; cannot resolve jsonl path")
    # Identical-content rewrites are skipped: the record freshness fingerprint
    # is mtime+size, so a byte-identical rewrite would still read as "source
    # changed" and re-arm the GET-time record refresh — the authoritative
    # reconcile calls this on every conversation open.
    write_text_if_changed(path, "".join(p.to_jsonl_line() + "\n" for p in pointers))


async def prune_message_pointer(rec: FSRecord, flow_message_id: str, notify: bool = True) -> bool:
    """Drop the pointer to ``flow_message_id`` from the conversation index and
    re-project. Mirror of ``append_message_pointer`` for removal.

    Pointer ids may carry the local ``@`` marker (``flow_message-@<id>``) while
    the caller passes the bare id, so both sides are normalised before compare.
    Idempotent: returns ``False`` (no re-projection) when the pointer is absent.
    """
    target = (flow_message_id or "").lstrip("@")
    if not target:
        return False
    pointers = message_pointers(rec)
    kept = [p for p in pointers if (p.id or "").lstrip("@") != target]
    if len(kept) == len(pointers):
        return False
    write_pointers(rec, kept)
    await project_pointers_to_entity(rec, notify=notify)
    return True


def from_jsonl(
    jsonl_path: Path,
    parent_id: str,
    record_id: str,
    *,
    parent_type: str = RecordType.TASK,
) -> FSRecord:
    """Construct an FSRecord for the canonical conversation.jsonl path.

    ``jsonl_path`` is accepted for callsite back-compat but the record always
    resolves its data file via ``default_jsonl_path(record_id)``.
    """
    canonical = default_jsonl_path(record_id)
    canonical.parent.mkdir(parents=True, exist_ok=True)
    if not canonical.exists():
        canonical.touch()
    rec = FSRecord(
        type=RecordType.CONVERSATION,
        id=record_id,
        name=f"conversation-{parent_id[:8]}" if parent_id else f"conversation-{record_id[:8]}",
        parent_id=parent_id,
        parent_type=parent_type,
    )
    if parent_type == RecordType.TASK:
        rec.__dict__["task_id"] = parent_id
    rec.asset_ref = FSRef(canonical)
    return rec


async def project_pointers_to_entity(rec: FSRecord, notify: bool = True) -> None:
    """Mirror the conversation's messages into ``message_ids``/``message_count``
    and set ``conv.updated_date`` to the conversation's recency.

    Membership and ORDER now come from the parent→child ``is_child`` edges,
    ordered by ``created_date`` — not from the on-disk pointer index. The jsonl
    keeps its other three jobs (outbound outbox, recipient-side import,
    DB-rebuild durability) and is still appended; it simply stopped being the
    ordering source, so there is one representation of "which messages are in
    this conversation" instead of two that could silently disagree.

    Edges are newer than the data, so a conversation that predates them has
    none — reading edges alone would blank its projection. The drift check
    below backfills first and re-reads; a converged conversation pays one set
    comparison and writes nothing.

    Recency is the last *real* message change — ``max(message.updated_date)``,
    NOT ``created_date`` (which never reflects an edit). ``FlowMessage.is_stale``
    keeps ``updated_date`` from advancing on a bare touch, so this ``max``
    excludes touches by construction: a body re-download bumps no message clock
    and therefore no inbox recency. ``updated_date`` stays the single field used
    for inbox order. With NO messages there is no max to take — see the
    empty-case comment below.
    """
    from datetime import datetime

    from flow_sdk._compat import UTC
    from flow_sdk.builtin.conversation import _PROJECTION_SENTINEL, Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.db.drivers.query import QueryFilter
    from flow_sdk.fs_store.pointer import Pointer
    from flow_sdk.fs_store.type_id import TypeId

    conv = await Conversation.get_one({"id": rec.id})
    if not conv:
        return

    async def _ordered_children() -> list[FlowMessage]:
        kids = await conv.get_children(
            child_filter=QueryFilter(type=FlowMessage.get_type(), order_by={"created_date": "asc"})
        )
        return [c.value for c in kids if getattr(c, "value", None) is not None]

    messages = await _ordered_children()
    # Legacy data (or a lost edge) — heal from the pointer index / conversation_id
    # before deriving anything, then re-read. Skipped entirely once converged.
    pointer_ids = {p.id for p in message_pointers(rec)}
    if pointer_ids - {m.id for m in messages}:
        await conv.ensure_message_edges()
        messages = await _ordered_children()

    new_count = len(messages)
    new_ids = (
        json.dumps(
            [
                Pointer(
                    TypeId(type=Pointer.DEFAULT_MESSAGE_TYPE, id=m.id),
                    (m.created_date.isoformat() if m.created_date is not None else ""),
                ).to_dict()
                for m in messages
            ]
        )
        if messages
        else None
    )

    new_updated = None
    for m in messages:
        ts = Conversation._as_datetime(m.updated_date or m.created_date)
        if ts is not None and (new_updated is None or ts > new_updated):
            new_updated = ts
    if new_updated is None:
        # No messages ⇒ no message activity ⇒ the honest recency is the birth
        # time. NEVER ``now()``: an empty conversation has not just happened, and
        # since ``updated_date`` is the Inbox sort key, stamping the current time
        # here promoted every message-less conversation above genuinely recent
        # mail on each catch-up that touched it. It also never converged — a
        # fresh ``now()`` differs from the stored value every time, so the row
        # re-saved and re-broadcast on every single sync. Reading ``created_date``
        # (rather than keeping the stored value) is also what lets a row already
        # carrying a fabricated timestamp repair itself on its next touch.
        new_updated = Conversation._as_datetime(conv.created_date)

    projection_changed = not (conv.message_ids == new_ids and conv.message_count == new_count)
    recency_changed = Conversation._as_datetime(conv.updated_date) != new_updated
    if not projection_changed and not recency_changed:
        return
    if projection_changed:
        conv._set_projection("message_ids", new_ids, _PROJECTION_SENTINEL)
        conv._set_projection("message_count", new_count, _PROJECTION_SENTINEL)
    # The projection write IS the "reconciled from hub/disk" moment for a
    # conversation — make it observable on the row the UI renders. Normal
    # field (not in _PROJECTED_FIELDS), so no sentinel needed.
    conv.fetched_at = datetime.now(UTC)
    conv.updated_date = new_updated
    local_user_typeid = await _resolve_local_owner_typeid()
    await conv.save(local_user_typeid, notify=notify)


async def _resolve_local_owner_typeid():
    try:
        from flow_sdk.builtin.user import User

        u = await User.get_one({"uname": "local"})
        return u.typeid if u else None
    except Exception:
        return None
