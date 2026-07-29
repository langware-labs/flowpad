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
from typing import Any, ClassVar, Optional

import logging

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity, action
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


class RemoteWorkerSessionStatus(StrEnum):
    """Host-authoritative status projection (mirrors ProcessStatus's StrEnum convention).

    Live-session lifecycle: DRAFT (guest-local, nothing shared) → PENDING
    (first prompt sent, awaiting host approval) → IDLE⇄RUNNING (active turns,
    with PAUSED as a host-side hold) → ENDED / DECLINED (terminal).
    """
    DRAFT = "draft"
    PENDING = "pending"
    IDLE = "idle"
    RUNNING = "running"
    PAUSED = "paused"
    ERROR = "error"
    ENDED = "ended"
    DECLINED = "declined"


# The two active sub-states a turn cycles between once the host approved.
ACTIVE_STATUSES = frozenset({RemoteWorkerSessionStatus.IDLE, RemoteWorkerSessionStatus.RUNNING})
# Absorbing states — no transition leaves them.
TERMINAL_STATUSES = frozenset({RemoteWorkerSessionStatus.ENDED, RemoteWorkerSessionStatus.DECLINED})

# Legal lifecycle moves. Anything → ENDED (disconnect wins from every live
# state); terminals absorb. PENDING→RUNNING is the pre-granted fast path
# (approve+run collapse into one step when ContactPermission auto-approves).
_TRANSITIONS: dict[str, frozenset] = {
    RemoteWorkerSessionStatus.DRAFT: frozenset({
        RemoteWorkerSessionStatus.PENDING, RemoteWorkerSessionStatus.ENDED,
    }),
    RemoteWorkerSessionStatus.PENDING: frozenset({
        RemoteWorkerSessionStatus.IDLE, RemoteWorkerSessionStatus.RUNNING,
        RemoteWorkerSessionStatus.DECLINED, RemoteWorkerSessionStatus.ENDED,
    }),
    RemoteWorkerSessionStatus.IDLE: frozenset({
        RemoteWorkerSessionStatus.RUNNING, RemoteWorkerSessionStatus.PAUSED,
        RemoteWorkerSessionStatus.ERROR, RemoteWorkerSessionStatus.ENDED,
    }),
    RemoteWorkerSessionStatus.RUNNING: frozenset({
        RemoteWorkerSessionStatus.IDLE, RemoteWorkerSessionStatus.PAUSED,
        RemoteWorkerSessionStatus.ERROR, RemoteWorkerSessionStatus.ENDED,
    }),
    RemoteWorkerSessionStatus.PAUSED: frozenset({
        RemoteWorkerSessionStatus.IDLE, RemoteWorkerSessionStatus.ENDED,
    }),
    RemoteWorkerSessionStatus.ERROR: frozenset({
        RemoteWorkerSessionStatus.IDLE, RemoteWorkerSessionStatus.RUNNING,
        RemoteWorkerSessionStatus.ENDED,
    }),
    RemoteWorkerSessionStatus.ENDED: frozenset(),
    RemoteWorkerSessionStatus.DECLINED: frozenset(),
}


def is_active(status: str | None) -> bool:
    """True when the session is approved and accepting prompts (IDLE/RUNNING)."""
    return status in ACTIVE_STATUSES


def is_terminal(status: str | None) -> bool:
    """True for the absorbing states (ENDED/DECLINED)."""
    return status in TERMINAL_STATUSES


def can_transition(current: str | None, new: str) -> bool:
    """Pure FSM validator. Unknown/empty ``current`` may adopt any state
    (materializing a snapshot for a session we've never seen)."""
    if current == new:
        return True
    if not current or current not in _TRANSITIONS:
        return True
    return new in _TRANSITIONS[current]


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
        sharing=Sharing.PRIVATE,
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

    # Message-borne snapshot fields — the hub-optional wire contract. This is
    # the pack whitelist (flow_message_bundle) AND the merge surface below.
    # ``host_process_id`` / ``project_id`` are deliberately absent: host-local,
    # path-leaking, and never another machine's to write.
    SNAPSHOT_FIELDS: ClassVar[frozenset[str]] = frozenset({
        "id", "type", "conversation_id", "collaboration_room_id",
        "host_user_id", "guest_user_id", "host_name", "guest_name",
        "status", "last_activity_at", "started_at",
    })
    # Host-authoritative subset: adopted from a snapshot only on the guest,
    # and only when the snapshot's activity clock is fresher.
    _HOST_AUTHORITATIVE_FIELDS: ClassVar[frozenset[str]] = frozenset({
        "status", "last_activity_at", "host_user_id", "host_name",
        "collaboration_room_id",
    })

    @classmethod
    def apply_snapshot(
        cls,
        local: Optional["RemoteWorkerSession"],
        snap: dict[str, Any],
        *,
        local_is_host: bool,
    ) -> "RemoteWorkerSession":
        """Merge a message-borne session snapshot into the local row.

        Merge discipline (unit-pinned):
        - No local row → materialize one from the snapshot fields verbatim.
        - Local is the HOST → the host is authoritative; only fill-merge
          identity fields the host row is missing (guest_name/guest_user_id
          from a guest-minted DRAFT). Never adopt status/clock from a snapshot.
        - Local is the GUEST → adopt the host-authoritative fields only when
          the snapshot's ``last_activity_at`` is strictly newer (ISO-UTC
          strings compare lexicographically); an older/equal snapshot never
          regresses local state. Fill-merge the rest.
        - ``host_process_id`` / ``project_id`` are never touched (not in
          ``SNAPSHOT_FIELDS``).
        """
        data = {k: v for k, v in (snap or {}).items() if k in cls.SNAPSHOT_FIELDS and v is not None}
        if local is None:
            return cls.model_validate({**data, "type": cls.get_type()})

        if local_is_host:
            # host_user_id/host_name included: a first carrier packed before the
            # guest's roster resolved the peer stamps host_user_id=None, and the
            # host row materialized from it could otherwise never acquire its own
            # identity (isHost stays false, the Approve bar never renders). Fill
            # only when missing — the host row is never overwritten.
            for field in ("guest_user_id", "guest_name", "conversation_id", "host_user_id", "host_name"):
                if not getattr(local, field, None) and data.get(field):
                    setattr(local, field, data[field])
            return local

        snap_clock = data.get("last_activity_at") or ""
        local_clock = local.last_activity_at or ""
        adopt_authoritative = bool(snap_clock) and snap_clock > local_clock
        for field, value in data.items():
            if field in ("id", "type"):
                continue
            if field in cls._HOST_AUTHORITATIVE_FIELDS:
                if adopt_authoritative:
                    setattr(local, field, value)
            elif not getattr(local, field, None):
                setattr(local, field, value)
        return local

    @classmethod
    async def resolve_state(cls, session_id: str) -> Optional["RemoteWorkerSession"]:
        """Current session state — THE seam gates and views read through.

        Today this is simply the local entity row: both the message-borne
        snapshot materializer and the host's own writes land there. When the
        optional hub real-time channel (``child_updated`` fanout) exists, it
        plugs in behind this method — callers never ``get_one`` directly.
        """
        if not session_id:
            return None
        return await cls.get_one({"id": session_id})

    def mark_activity(self, status: str | None = None) -> None:
        """Stamp host-authoritative activity; caller saves."""
        self.last_activity_at = _now_iso()
        if status is not None:
            self.status = status

    async def _emit_event(self, event: str, *, text: str | None = None) -> None:
        """Best-effort SESSION_EVENT system line into the bound conversation
        (which also ships a fresh snapshot to the other side — see
        ``emit_session_event``). Never fails the action."""
        try:
            from flow_sdk.app.actions.execute_prompt import emit_session_event  # noqa: PLC0415
            from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
            ri = get_current_request_info()
            someone = (getattr(ri, "someone_typeid", None) or "") if ri else ""
            await emit_session_event(self, event, someone, text=text)
        except Exception as e:  # noqa: BLE001
            logger.warning("[remote_worker_session] %s event emit failed: %s", event, e)

    async def _transition_action(self, new_status: str, event: str) -> ApiResponse:
        """Shared body of the lifecycle actions: FSM-validate, stamp, save,
        announce. Self-transition is an idempotent no-op (no duplicate line)."""
        if self.status == new_status:
            return ApiSuccessResponse(data=self.model_dump(mode="json"))
        if not can_transition(self.status, new_status):
            return ApiFailResponse(
                message=f"illegal live-session transition: {self.status} → {new_status}"
            )
        self.mark_activity(new_status)
        await self.save()
        await self._emit_event(event)
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="approve")
    async def _http_approve(self) -> ApiResponse:
        """Host approves a PENDING live session (PENDING→IDLE) and re-drives the
        prompts that queued while awaiting approval — detached, so the click
        returns immediately; ``prompt_auto_handled``-before-run keeps the
        re-drive idempotent against concurrently arriving prompts."""
        result = await self._transition_action(RemoteWorkerSessionStatus.IDLE, "approved")
        if isinstance(result, ApiSuccessResponse):
            import asyncio  # noqa: PLC0415
            from flow_sdk.app.actions.execute_prompt import redrive_session_prompts  # noqa: PLC0415
            asyncio.create_task(redrive_session_prompts(self))
        return result

    @action.post(action_name="decline")
    async def _http_decline(self) -> ApiResponse:
        """Host declines a PENDING live session (terminal)."""
        return await self._transition_action(RemoteWorkerSessionStatus.DECLINED, "declined")

    @action.post(action_name="pause")
    async def _http_pause(self) -> ApiResponse:
        """Host holds the session: further inbound prompts bounce (with a
        system line) instead of running, until resume."""
        return await self._transition_action(RemoteWorkerSessionStatus.PAUSED, "paused")

    @action.post(action_name="resume")
    async def _http_resume(self) -> ApiResponse:
        """Host lifts a pause (PAUSED→IDLE)."""
        return await self._transition_action(RemoteWorkerSessionStatus.IDLE, "resumed")

    @action.post(action_name="disconnect")
    async def _http_disconnect(self) -> ApiResponse:
        """End this shared session — the host cutting off remote access to their
        machine. Marks the session ENDED and best-effort stops the host worker so
        no further guest prompts run. Idempotent."""
        already_ended = self.status == RemoteWorkerSessionStatus.ENDED
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
        if not already_ended:
            await self._emit_event("ended")
        return ApiSuccessResponse(data=self.model_dump(mode="json"))
