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
from flow_sdk.fs_store.fs_record import FSRecord, record_stem
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.type_id import TypeId


def default_data_dir(record_id: str) -> Path:
    if not record_id:
        raise ValueError("record_id is required")
    from flow_sdk.fs_store.record_paths import get_default_records_data_root
    return (
        get_default_records_data_root()
        / RecordType.CONVERSATION
        / record_stem(RecordType.CONVERSATION, record_id)
    )


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
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for p in pointers:
            fh.write(p.to_jsonl_line() + "\n")


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
    """Mirror the on-disk pointer index into Conversation.message_ids/message_count.

    Bumps ``conv.updated_date`` to the latest pointer's ts.
    """
    from datetime import datetime
    from flow_sdk._compat import UTC
    from flow_sdk.builtin.conversation import Conversation, _PROJECTION_SENTINEL

    conv = await Conversation.get_one({"id": rec.id})
    if not conv:
        return
    pointers = message_pointers(rec)
    new_count = len(pointers)
    new_ids = json.dumps([p.to_dict() for p in pointers]) if pointers else None
    if conv.message_ids == new_ids and conv.message_count == new_count:
        return
    conv._set_projection("message_ids", new_ids, _PROJECTION_SENTINEL)
    conv._set_projection("message_count", new_count, _PROJECTION_SENTINEL)
    latest_ts = pointers[-1].ts if pointers else None
    if latest_ts:
        try:
            conv.updated_date = datetime.fromisoformat(latest_ts.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            conv.updated_date = datetime.now(UTC)
    else:
        conv.updated_date = datetime.now(UTC)
    local_user_typeid = await _resolve_local_owner_typeid()
    await conv.save(local_user_typeid, notify=notify)


async def _resolve_local_owner_typeid():
    try:
        from flow_sdk.builtin.user import User
        u = await User.get_one({"uname": "local"})
        return u.typeid if u else None
    except Exception:
        return None
