"""TeamSession entity — collaborative session bound 1:1 to an AgenticProcess."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.fs_records.team_session_record import (
    TeamSessionStatus,
    _generate_session_code,
)
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class TeamSession(Entity):
    """Entity representing a collaborative session on an AgenticProcess."""

    type: str = APIField(default="team_session")
    session_code: str = APIField(default="", description="Shareable join code, e.g. ABCD-EFGH")
    agentic_process_id: str | None = APIField(default=None, description="Bound AgenticProcess id")
    host_name: str | None = APIField(default=None, description="Display name of the host")
    host_member_id: str | None = APIField(default=None, description="Stable member_id of the host")
    members: list[dict] = APIField(
        default_factory=list,
        description="Participants: [{member_id, name, joined_at, last_seen_at}]",
    )
    status: str = APIField(default=TeamSessionStatus.ACTIVE)
    created_at: str | None = APIField(default=None)
    ended_at: str | None = APIField(default=None)

    _api_visible: ClassVar[bool] = True

    # ── Construction ──────────────────────────────────────────────────────────

    def __init__(self, **data: Any) -> None:
        if not data.get("session_code"):
            data["session_code"] = _generate_session_code()
        if not data.get("created_at"):
            data["created_at"] = _now_iso()
        super().__init__(**data)

    # ── Member helpers ────────────────────────────────────────────────────────

    def _find_member(self, member_id: str) -> dict | None:
        for m in self.members or []:
            if m.get("member_id") == member_id:
                return m
        return None

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
            await self.save()
        return changed

    # ── Lookup ────────────────────────────────────────────────────────────────

    @classmethod
    async def get_by_code(cls, code: str) -> "TeamSession | None":
        """Find active TeamSession by session_code (case-insensitive)."""
        normalized = (code or "").upper().strip()
        if not normalized:
            return None
        all_sessions = await cls.get_all()
        for ts in all_sessions:
            if (ts.session_code or "").upper() == normalized and ts.status == TeamSessionStatus.ACTIVE:
                return ts
        return None

    @classmethod
    async def get_by_agentic_process(cls, agentic_process_id: str) -> "TeamSession | None":
        """Find active TeamSession bound to an AgenticProcess."""
        if not agentic_process_id:
            return None
        all_sessions = await cls.get_all()
        for ts in all_sessions:
            if ts.agentic_process_id == agentic_process_id and ts.status == TeamSessionStatus.ACTIVE:
                return ts
        return None

    # ── HTTP actions ──────────────────────────────────────────────────────────

    @action.post(action_name="join")
    async def _http_join(self) -> ApiResponse:
        """POST body: {member_id, name} → upsert member, return entity."""
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
        """POST body: {member_id} → bump last_seen_at."""
        request_info = get_current_request_info()
        body = await request_info.get_post_data() if request_info else {}
        member_id = body.get("member_id")
        if not member_id:
            return ApiFailResponse(message="member_id is required")
        updated = await self.touch_member(member_id)
        return ApiSuccessResponse(data={"ok": updated, "members": self.members})

    @action.post(action_name="end")
    async def _http_end(self) -> ApiResponse:
        """End the collaborative session."""
        self.status = TeamSessionStatus.ENDED
        self.ended_at = _now_iso()
        await self.save()
        return ApiSuccessResponse(data=self.model_dump(mode="json"))
