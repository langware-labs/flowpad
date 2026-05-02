"""CollaborationRoomRecord -- filesystem record for a collaboration room
on a project.

A collaboration room is the persistent space where collaborators meet around
a project — it owns the AgenticProcesses spawned in the room and tracks the
participants who are currently or were ever present.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timezone
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CollaborationRoomStatus:
    ACTIVE = "active"
    ENDED = "ended"


class CollaborationRoomRecord(Record):
    _record_type: ClassVar[str] = RecordType.COLLABORATION_ROOM
    _indexed_by_default: ClassVar[bool] = False
    index_fields: ClassVar[list[str]] = ["project_id", "updated_at"]

    def __init__(self, **kwargs: Any) -> None:
        if "id" not in kwargs:
            kwargs["id"] = str(_uuid.uuid4())
        kwargs.setdefault("type", RecordType.COLLABORATION_ROOM)
        now = _now_iso()
        # space_id is no longer part of the schema — drop it if a legacy record
        # still carries it so the entity doesn't refuse to load.
        kwargs.pop("space_id", None)
        kwargs.setdefault("project_id", None)
        kwargs.setdefault("host_name", None)
        kwargs.setdefault("host_member_id", None)
        kwargs.setdefault("name", None)
        kwargs.setdefault("members", [])
        # ``agentic_process_ids`` lived on the entity historically; it now
        # consolidates into ``context_entities`` (TypeId list). For old records
        # that still carry the legacy field, route it into context_entities so
        # the entity loads cleanly.
        legacy_procs = kwargs.pop("agentic_process_ids", None)
        ctx = list(kwargs.get("context_entities") or [])
        if legacy_procs:
            for pid in legacy_procs:
                tid = f"agentic_process-{pid}"
                if tid not in ctx:
                    ctx.append(tid)
        kwargs["context_entities"] = ctx
        kwargs.setdefault("status", CollaborationRoomStatus.ACTIVE)
        kwargs.setdefault("started_at", now)
        kwargs.setdefault("updated_at", now)
        kwargs.setdefault("ended_at", None)
        super().__init__(**kwargs)

    def _mark_dirty(self, key: str) -> None:
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add(key)

    def touch(self) -> None:
        object.__setattr__(self, "updated_at", _now_iso())
        self._mark_dirty("updated_at")

    def add_process(self, process_id: str) -> bool:
        """Append an agentic_process to the room's context. Returns True if added."""
        ctx = list(object.__getattribute__(self, "__dict__").get("context_entities") or [])
        tid = f"agentic_process-{process_id}"
        if tid in ctx:
            return False
        ctx.append(tid)
        object.__setattr__(self, "context_entities", ctx)
        self._mark_dirty("context_entities")
        self.touch()
        return True

    def upsert_member(self, member_id: str, name: str) -> dict:
        """Insert or update a participant by member_id. Returns the member dict."""
        members = list(object.__getattribute__(self, "__dict__").get("members") or [])
        now = _now_iso()
        for m in members:
            if m.get("member_id") == member_id:
                m["name"] = name
                m["last_seen_at"] = now
                if not m.get("joined_at"):
                    m["joined_at"] = now
                object.__setattr__(self, "members", members)
                self._mark_dirty("members")
                self.touch()
                return m
        entry = {
            "member_id": member_id,
            "name": name,
            "joined_at": now,
            "last_seen_at": now,
        }
        members.append(entry)
        object.__setattr__(self, "members", members)
        self._mark_dirty("members")
        self.touch()
        return entry

    def end(self) -> None:
        object.__setattr__(self, "status", CollaborationRoomStatus.ENDED)
        object.__setattr__(self, "ended_at", _now_iso())
        self._mark_dirty("status")
        self._mark_dirty("ended_at")
        self.touch()
