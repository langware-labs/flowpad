"""CollaborationSpaceRecord -- filesystem record for collaboration spaces.

Backs a persistent "space" where users meet to assist and get assisted —
Zoom/Slack-style. Users work in their own projects but share specific tabs,
docs, and plans into a space. The host controls data flow.
"""

from __future__ import annotations

import random
import string
import uuid as _uuid
from datetime import datetime, timezone
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _generate_session_code() -> str:
    alphabet = string.ascii_uppercase + string.digits
    left = "".join(random.choices(alphabet, k=4))
    right = "".join(random.choices(alphabet, k=4))
    return f"{left}-{right}"


class CollaborationSpaceStatus:
    ACTIVE = "active"
    ENDED = "ended"


class CollaborationSpaceRecord(Record):
    _record_type: ClassVar[str] = RecordType.COLLABORATION_SPACE
    _indexed_by_default: ClassVar[bool] = False
    index_fields: ClassVar[list[str]] = ["session_code", "project_id"]

    def __init__(self, **kwargs: Any) -> None:
        if "id" not in kwargs:
            kwargs["id"] = str(_uuid.uuid4())
        kwargs.setdefault("type", RecordType.COLLABORATION_SPACE)
        kwargs.setdefault("session_code", _generate_session_code())
        kwargs.setdefault("name", None)
        kwargs.setdefault("host_name", None)
        kwargs.setdefault("host_member_id", None)
        kwargs.setdefault("members", [])
        kwargs.setdefault("project_id", None)
        kwargs.setdefault("is_default", False)
        kwargs.setdefault("status", CollaborationSpaceStatus.ACTIVE)
        kwargs.setdefault("created_at", _now_iso())
        kwargs.setdefault("ended_at", None)
        super().__init__(**kwargs)

    def _mark_dirty(self, key: str) -> None:
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add(key)

    def upsert_member(self, member_id: str, name: str) -> dict:
        """Insert or update a member by member_id. Returns the member dict."""
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
        return entry

    def touch_member(self, member_id: str) -> bool:
        """Bump last_seen_at for member_id. Returns True if updated."""
        members = list(object.__getattribute__(self, "__dict__").get("members") or [])
        now = _now_iso()
        for m in members:
            if m.get("member_id") == member_id:
                m["last_seen_at"] = now
                object.__setattr__(self, "members", members)
                self._mark_dirty("members")
                return True
        return False

    def end(self) -> None:
        object.__setattr__(self, "status", CollaborationSpaceStatus.ENDED)
        object.__setattr__(self, "ended_at", _now_iso())
        self._mark_dirty("status")
        self._mark_dirty("ended_at")
