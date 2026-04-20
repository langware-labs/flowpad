"""CollaborationSession entity — a single meeting inside a CollaborationSpace.

A space is the persistent team room; a session is one meeting event. Sessions
own the AgenticProcesses spawned during the meeting and hold the participants
who joined it.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.fs_records.collaboration_session_record import CollaborationSessionStatus
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class CollaborationSession(Entity):
    """Entity representing one meeting inside a CollaborationSpace."""

    type: str = APIField(default="collaboration_session")
    space_id: str | None = APIField(default=None, description="Owning CollaborationSpace id")
    project_id: str | None = APIField(default=None, description="Denormalized project id from the space")
    host_name: str | None = APIField(default=None, description="Display name of the host")
    host_member_id: str | None = APIField(default=None, description="Stable member_id of the host")
    name: str | None = APIField(default=None, description="Optional human title for this meeting")
    members: list[dict] = APIField(
        default_factory=list,
        description="Participants: [{member_id, name, joined_at, last_seen_at}]",
    )
    agentic_process_ids: list[str] = APIField(
        default_factory=list,
        description="AgenticProcess ids spawned during this session",
    )
    status: str = APIField(default=CollaborationSessionStatus.ACTIVE)
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
        procs = list(self.agentic_process_ids or [])
        if process_id in procs:
            return False
        procs.append(process_id)
        self.agentic_process_ids = procs
        self._touch()
        await self.save()
        return True

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
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        process_id = body.get("agentic_process_id")
        if not process_id:
            return ApiFailResponse(message="agentic_process_id is required")
        added = await self.add_process(process_id)
        return ApiSuccessResponse(data={"ok": added, "agentic_process_ids": self.agentic_process_ids})

    @action.post(action_name="end")
    async def _http_end(self) -> ApiResponse:
        self.status = CollaborationSessionStatus.ENDED
        self.ended_at = _now_iso()
        self._touch()
        await self.save()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))
