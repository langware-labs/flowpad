"""CollaborationRoom entity — a collaboration room on a project.

A collaboration room is a persistent space where collaborators meet around a
project. The room owns the AgenticProcesses spawned in it and holds the
participants who joined.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import TypeId
from flow_sdk.fs_records.collaboration_room_record import CollaborationRoomStatus
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CollaborationRoom(Entity):
    """Entity representing a collaboration room on a project."""

    type: str = APIField(default="collaboration_room")
    host_name: str | None = APIField(default=None, description="Display name of the host")
    host_member_id: str | None = APIField(default=None, description="Stable member_id of the host")
    name: str | None = APIField(default=None, description="Optional human title for this room")
    members: list[dict] = APIField(
        default_factory=list,
        description="Participants: [{member_id, name, joined_at, last_seen_at}]",
    )
    status: str = APIField(default=CollaborationRoomStatus.ACTIVE)
    started_at: str | None = APIField(default=None)
    updated_at: str | None = APIField(default=None)
    ended_at: str | None = APIField(default=None)

    _api_visible: ClassVar[bool] = True

    # ── Construction ──────────────────────────────────────────────────────────

    def __init__(self, **data: Any) -> None:
        now = _now_iso()
        if not data.get("started_at"):
            data["started_at"] = now
        if not data.get("updated_at"):
            data["updated_at"] = now
        super().__init__(**data)

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _touch(self) -> None:
        self.updated_at = _now_iso()

    async def upsert_member(self, member_id: str, name: str) -> dict:
        now = _now_iso()
        members = list(self.members or [])
        existing = None
        for m in members:
            if m.get("member_id") == member_id:
                existing = m
                break
        if existing is not None:
            existing["name"] = name
            existing["last_seen_at"] = now
            if not existing.get("joined_at"):
                existing["joined_at"] = now
            entry = existing
        else:
            entry = {
                "member_id": member_id,
                "name": name,
                "joined_at": now,
                "last_seen_at": now,
            }
            members.append(entry)
        self.members = members
        self._touch()
        await self.save()
        return entry

    async def touch_member(self, member_id: str) -> bool:
        members = list(self.members or [])
        now = _now_iso()
        changed = False
        for m in members:
            if m.get("member_id") == member_id:
                m["last_seen_at"] = now
                changed = True
                break
        if changed:
            self.members = members
            self._touch()
            await self.save()
        return changed

    async def add_process(self, process_id: str) -> bool:
        process_typeid = TypeId(type="agentic_process", id=process_id)
        added = self.add_shared_context_entities(process_typeid)
        if not added:
            return False
        self._touch()
        await self.save()
        return True

    @property
    def agentic_process_ids(self) -> list[str]:
        """Convenience: list of agentic_process ids in this room's shared
        context. Read-only — append via ``add_process`` /
        ``add_shared_context_entities``.
        """
        return [t.id for t in self.context_of_type("agentic_process", bucket="shared")]

    # ── HTTP actions ──────────────────────────────────────────────────────────

    @action.post(action_name="join")
    async def _http_join(self) -> ApiResponse:
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        member_id = body.get("member_id")
        name = body.get("name")
        if not member_id or not name:
            return ApiFailResponse(message="member_id and name are required")
        await self.upsert_member(member_id=member_id, name=name)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="heartbeat")
    async def _http_heartbeat(self) -> ApiResponse:
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        member_id = body.get("member_id")
        if not member_id:
            return ApiFailResponse(message="member_id is required")
        updated = await self.touch_member(member_id)
        return ApiSuccessResponse(data={"ok": updated, "members": self.members})

    @action.post(action_name="add_process")
    async def _http_add_process(self) -> ApiResponse:
        from flow_sdk.builtin.agentic_process import AgenticProcess

        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        process_id = body.get("agentic_process_id")
        if not process_id:
            return ApiFailResponse(message="agentic_process_id is required")

        # Format-validate so malformed ids return a structured FAIL instead of
        # leaking a 500 from TypeId._pydantic_validate.
        try:
            process_typeid = TypeId(type="agentic_process", id=process_id)
        except Exception as exc:
            return ApiFailResponse(message=f"agentic_process_id is malformed: {exc}")

        # Existence check — silently appending a non-resolving id was the
        # validation gap the Phase 8 RCA identified (lost during the
        # context_entities consolidation).
        process = await AgenticProcess.get_one({"id": process_typeid.id})
        if process is None:
            return ApiFailResponse(message=f"AgenticProcess {process_id} not found")

        added = await self.add_process(process_id)
        return ApiSuccessResponse(
            data={
                "ok": added,
                "shared_context_entities": [str(t) for t in self.shared_context_entities],
            }
        )

    @action.post(action_name="end")
    async def _http_end(self) -> ApiResponse:
        self.status = CollaborationRoomStatus.ENDED
        self.ended_at = _now_iso()
        self._touch()
        await self.save()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))
