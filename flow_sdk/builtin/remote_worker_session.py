"""RemoteWorkerSession — a host/guest remote-execution session.

Lives **inside** a CollaborationRoom (alongside the room's files and assets): a
guest sends Prompts and the host's worker runs them and returns PromptResults. The
session is asymmetric — the **host** runs the actual worker (its local reused
headless AgenticProcess), the **guest** requests and watches. Both sides open the
same shared session id inside the room; the Prompt/PromptResult exchange rides the
bound conversation's FlowMessages as attachments (see execute_prompt.py).

Host-only fields (``host_process_id``, ``project_id``) are meaningful only on the
host's instance — the guest holds the shared identity + the coarse ``status``
projection and reconstructs the turn stream from the exchange.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import logging

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.responses.response import ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


class RemoteWorkerSessionStatus(StrEnum):
    """Host-authoritative status projection (mirrors ProcessStatus's StrEnum convention)."""
    IDLE = "idle"
    RUNNING = "running"
    ERROR = "error"
    ENDED = "ended"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class RemoteWorkerSession(Entity):
    """A host/guest remote-execution session inside a CollaborationRoom."""

    type: str = APIField(default="remote_worker_session")

    conversation_id: Optional[str] = APIField(
        default=None, description="Conversation whose messages carry the Prompt/PromptResult exchange."
    )
    collaboration_room_id: Optional[str] = APIField(
        default=None, description="CollaborationRoom this session lives inside."
    )

    # Host/guest asymmetry. Roles are authoritative here; the room roster still
    # governs who may open the session (like Conversation).
    host_user_id: Optional[str] = APIField(
        default=None, description="User whose machine runs the worker (the executor)."
    )
    guest_user_id: Optional[str] = APIField(
        default=None, description="User who requests runs (the caller)."
    )
    # Denormalized display names (mirrors CollaborationRoom.host_name): host_user_id
    # is a LOCAL user id while guest_user_id is the sender's HUB id — different id
    # spaces — so stamping the names at write time lets any viewer render them
    # without reconstructing from two rosters.
    host_name: Optional[str] = APIField(default=None, description="Display name of the host.")
    guest_name: Optional[str] = APIField(default=None, description="Display name of the guest.")

    # Host-only (null on the guest's mirror).
    host_process_id: Optional[str] = APIField(
        default=None, description="Host-side AgenticProcess that executes prompts (host only)."
    )
    project_id: Optional[str] = APIField(
        default=None, description="Host project/workdir the worker runs in (host only)."
    )

    # Host-authoritative, synced projection so the guest can render live state.
    status: str = APIField(default=RemoteWorkerSessionStatus.IDLE)
    last_activity_at: Optional[str] = APIField(default=None)
    started_at: Optional[str] = APIField(default=None)

    def __init__(self, **data: Any) -> None:
        if not data.get("started_at"):
            data["started_at"] = _now_iso()
        super().__init__(**data)

    def is_host(self, user_id: str | None) -> bool:
        """True when ``user_id`` is this session's host (the executor)."""
        return bool(self.host_user_id) and user_id == self.host_user_id

    def mark_activity(self, status: str | None = None) -> None:
        """Stamp host-authoritative activity; caller saves."""
        self.last_activity_at = _now_iso()
        if status is not None:
            self.status = status

    @action.post(action_name="disconnect")
    async def _http_disconnect(self) -> ApiResponse:
        """End this shared session — the host cutting off remote access to their
        machine. Marks the session ENDED and best-effort stops the host worker so
        no further guest prompts run. Idempotent."""
        self.mark_activity(RemoteWorkerSessionStatus.ENDED)
        await self.save()
        # Best-effort: stop the host-side worker so queued/future remote prompts
        # can't keep running on the host's machine after disconnect.
        if self.host_process_id:
            try:
                from flow_sdk.builtin.agentic_process import AgenticProcess
                ap = await AgenticProcess.get_one({"id": self.host_process_id})
                if ap is not None and getattr(ap, "shell_id", None):
                    await ap.exit()
            except Exception as e:  # noqa: BLE001
                logger.warning("[remote_worker_session] disconnect: host worker stop failed: %s", e)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))
