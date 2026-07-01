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

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


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

    # Host/guest asymmetry. Roles are authoritative here; the room roster still
    # governs who may open the session (like Conversation).
    host_user_id: Optional[str] = APIField(
        default=None, description="User whose machine runs the worker (the executor)."
    )
    guest_user_id: Optional[str] = APIField(
        default=None, description="User who requests runs (the caller)."
    )

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
