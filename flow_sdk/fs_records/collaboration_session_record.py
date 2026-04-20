"""CollaborationSessionRecord -- filesystem record for a single meeting
inside a CollaborationSpace.

A CollaborationSpace is the persistent team room. A CollaborationSession is
one specific meeting that happens inside the space — Zoom-call shaped: starts,
has participants, ends. Sessions own the AgenticProcesses spawned during the
meeting.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timezone
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CollaborationSessionStatus:
    ACTIVE = "active"
    ENDED = "ended"


class CollaborationSessionRecord(Record):
    _record_type: ClassVar[str] = RecordType.COLLABORATION_SESSION
    _indexed_by_default: ClassVar[bool] = False
    index_fields: ClassVar[list[str]] = ["project_id", "updated_at"]

    def __init__(self, **kwargs: Any) -> None:
        if "id" not in kwargs:
            kwargs["id"] = str(_uuid.uuid4())
        kwargs.setdefault("type", RecordType.COLLABORATION_SESSION)
        now = _now_iso()
        # space_id is no longer part of the schema — drop it if a legacy record
        # still carries it so the entity doesn't refuse to load.
        kwargs.pop("space_id", None)
        kwargs.setdefault("project_id", None)
        kwargs.setdefault("host_name", None)
        kwargs.setdefault("host_member_id", None)
        kwargs.setdefault("name", None)
        kwargs.setdefault("members", [])
        kwargs.setdefault("agentic_process_ids", [])
        kwargs.setdefault("status", CollaborationSessionStatus.ACTIVE)
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
        """Append an agentic_process_id to the session's list. Returns True if added."""
        procs = list(object.__getattribute__(self, "__dict__").get("agentic_process_ids") or [])
        if process_id in procs:
            return False
        procs.append(process_id)
        object.__setattr__(self, "agentic_process_ids", procs)
        self._mark_dirty("agentic_process_ids")
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
        object.__setattr__(self, "status", CollaborationSessionStatus.ENDED)
        object.__setattr__(self, "ended_at", _now_iso())
        self._mark_dirty("status")
        self._mark_dirty("ended_at")
        self.touch()
