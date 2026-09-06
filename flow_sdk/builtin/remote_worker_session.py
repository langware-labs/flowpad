"""RemoteWorkerSession — a host/guest remote-execution session.

Lives **inside** a CollaborationRoom (alongside the room's files and assets): a
guest sends Prompts and the host's worker runs them and returns PromptCompletions. The
session is asymmetric — the **host** runs the actual worker (its local reused
headless AgenticProcess), the **guest** requests and watches. Both sides open the
same shared session id inside the room; the Prompt/PromptCompletion exchange rides the
bound conversation's FlowMessages as attachments (see execute_prompt.py).

Host-only fields (``host_process_id``, ``project_id``) are meaningful only on the
host's instance — the guest holds the shared identity + the coarse ``status``
projection and reconstructs the turn stream from the exchange.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, ClassVar, Optional

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


class ReplyPolicy(StrEnum):
    """What happens to a captured reply. Proposed by the guest on the opening
    prompt, host-authoritative afterwards, editable in the session view."""
    AUTO = "auto"      # send as soon as captured
    REVIEW = "review"  # save as a host draft inside the session


class ApprovedVia(StrEnum):
    MANUAL = "manual"                  # the host clicked Approve
    STANDING_GRANT = "standing_grant"  # a ContactPermission pre-approved it


class InboundDecision(StrEnum):
    """What the host does with an inbound prompt, given the session's state."""
    IGNORE = "ignore"        # terminal session — nothing runs, marker untouched
    PARK_PENDING = "park"    # no consent yet — stays queued until approve
    BOUNCE_PAUSED = "bounce" # host paused — consumed with a system line
    RUN = "run"              # active (or pre-approved) — run the turn


# The two active sub-states a turn cycles between once the host approved.
ACTIVE_STATUSES = frozenset({RemoteWorkerSessionStatus.IDLE, RemoteWorkerSessionStatus.RUNNING})
# States a turn may run in: ACTIVE plus ERROR (the next turn is the retry).
RUNNABLE_STATUSES = ACTIVE_STATUSES | {RemoteWorkerSessionStatus.ERROR}
# States that mean "no consent yet" — a standing grant collapses these to RUN.
UNAPPROVED_STATUSES = frozenset({RemoteWorkerSessionStatus.DRAFT, RemoteWorkerSessionStatus.PENDING})
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


def decide_inbound_prompt(*, status: str | None, standing_grant: bool) -> InboundDecision:
    """THE inbound gate, as a pure function of session state.

    terminal → IGNORE; PAUSED → BOUNCE; IDLE/RUNNING/ERROR → RUN;
    PENDING/DRAFT/unknown → RUN when a standing grant pre-approves the
    session, else PARK. No message-level concern lives here — draft / own-send
    / already-consumed guards belong to the async wrapper that has the DB.
    """
    if is_terminal(status):
        return InboundDecision.IGNORE
    if status == RemoteWorkerSessionStatus.PAUSED:
        return InboundDecision.BOUNCE_PAUSED
    if status in RUNNABLE_STATUSES:
        return InboundDecision.RUN
    return InboundDecision.RUN if standing_grant else InboundDecision.PARK_PENDING


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class RemoteWorkerSession(Entity):
    """A host/guest remote-execution session inside a CollaborationRoom."""

    type: str = APIField(default="remote_worker_session")

    conversation_id: Optional[str] = APIField(
        default=None, description="Conversation whose messages carry the Prompt/PromptCompletion exchange."
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

    # The main-thread prompt that OPENED this session. The thread renders the
    # session card under it and hides every other message stamped with this
    # session id. Guest stamps it at send; host fill-merges it from the carrier.
    starting_message_id: Optional[str] = APIField(
        default=None, description="FlowMessage that opened the session (the card's anchor)."
    )
    # Session settings. ``reply_policy`` None = auto. Host-authoritative once
    # the session exists; the guest's proposal rides the start marker.
    reply_policy: Optional[str] = APIField(
        default=None, description="ReplyPolicy: auto (send replies) | review (host drafts)."
    )
    approved_at: Optional[str] = APIField(default=None, description="ISO-UTC when the host approved.")
    approved_via: Optional[str] = APIField(default=None, description="ApprovedVia: manual | standing_grant.")

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

    @property
    def effective_reply_policy(self) -> ReplyPolicy:
        try:
            return ReplyPolicy(self.reply_policy) if self.reply_policy else ReplyPolicy.AUTO
        except ValueError:
            return ReplyPolicy.AUTO

    # Message-borne snapshot fields — the hub-optional wire contract. This is
    # the pack whitelist (flow_message_bundle) AND the merge surface below.
    # ``host_process_id`` / ``project_id`` are deliberately absent: host-local,
    # path-leaking, and never another machine's to write.
    SNAPSHOT_FIELDS: ClassVar[frozenset[str]] = frozenset({
        "id", "type", "conversation_id", "collaboration_room_id",
        "host_user_id", "guest_user_id", "host_name", "guest_name",
        "status", "last_activity_at", "started_at",
        "starting_message_id", "reply_policy", "approved_at", "approved_via",
    })
    # Host-authoritative subset: adopted from a snapshot only on the guest,
    # and only when the snapshot's activity clock is fresher.
    _HOST_AUTHORITATIVE_FIELDS: ClassVar[frozenset[str]] = frozenset({
        "status", "last_activity_at", "host_user_id", "host_name",
        "collaboration_room_id", "reply_policy", "approved_at", "approved_via",
    })
    # Identity the host row may be MISSING when it materialized from a guest
    # carrier packed before the guest's roster resolved — filled once, never
    # overwritten. ``starting_message_id`` / ``reply_policy`` are the guest's
    # opening proposal, adopted the same fill-only way.
    _HOST_FILL_FIELDS: ClassVar[tuple[str, ...]] = (
        "guest_user_id", "guest_name", "conversation_id", "host_user_id", "host_name",
        "starting_message_id", "reply_policy",
    )

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
            for field in cls._HOST_FILL_FIELDS:
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
    async def adopt_snapshot(
        cls, snap: dict[str, Any], *, someone_typeid: str | None = None,
    ) -> Optional["RemoteWorkerSession"]:
        """Materialize/refresh the local row from a message-borne snapshot —
        the ONE receive-side adopt path (bundle header AND carrier-preview fast
        path). Host/guest is decided here: the local side is the host when it
        already runs the worker or when the snapshot's ``host_user_id`` is our
        cloud identity; ``apply_snapshot`` then enforces the merge discipline."""
        from flow_sdk.cli.app_config import get_user as _get_cloud_user  # noqa: PLC0415

        sid = snap.get("id")
        if not sid:
            return None
        existing = await cls.get_one({"id": sid})
        cloud_uid = (_get_cloud_user() or {}).get("id")
        local_is_host = bool(
            (existing is not None and getattr(existing, "host_process_id", None))
            or (cloud_uid and snap.get("host_user_id") == cloud_uid)
        )
        rws = cls.apply_snapshot(existing, {**snap, "id": sid}, local_is_host=local_is_host)
        await rws.save(someone_typeid) if someone_typeid else await rws.save()
        return rws

    def snapshot(self) -> dict[str, Any]:
        """The wire snapshot (``SNAPSHOT_FIELDS`` only — never host-local paths).
        ``skip_api_serializer``: the API serializer would add its ``expand``
        envelope, which is not session state."""
        data = self.model_dump(
            mode="json", include=set(self.SNAPSHOT_FIELDS), context={"skip_api_serializer": True},
        )
        return {k: v for k, v in data.items() if k in self.SNAPSHOT_FIELDS}

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

    async def _emit_event(self, event: str, *, text: str | None = None, someone_typeid: str | None = None) -> None:
        """Best-effort SESSION_EVENT system line into the bound conversation
        (which also ships a fresh snapshot to the other side — see
        ``emit_session_event``). Never fails the action. Outside a request
        (the inbound gate) the caller passes the local user's typeid."""
        try:
            from flow_sdk.app.actions.execute_prompt import emit_session_event  # noqa: PLC0415
            from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415
            someone = someone_typeid
            if not someone:
                ri = get_current_request_info()
                someone = (getattr(ri, "someone_typeid", None) or "") if ri else ""
            if not someone:
                from flow_sdk.server.routes.bootstrap import get_or_create_local_user  # noqa: PLC0415
                local = await get_or_create_local_user()
                someone = str(local.typeid) if local else ""
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

    async def approve(self, *, via: str = ApprovedVia.MANUAL, someone_typeid: str | None = None) -> bool:
        """Consent: PENDING/DRAFT → IDLE with the approval stamped. Returns
        False when the move is illegal (already terminal). Idempotent on an
        already-active session. Announces with an ``approved`` line so the
        guest's mirror flips. Shared by the Approve control and the
        standing-grant path of the inbound gate."""
        if self.status in ACTIVE_STATUSES:
            return True
        if not can_transition(self.status, RemoteWorkerSessionStatus.IDLE):
            return False
        self.approved_at = _now_iso()
        self.approved_via = str(via)
        self.mark_activity(RemoteWorkerSessionStatus.IDLE)
        await self.save()
        await self._emit_event("approved", someone_typeid=someone_typeid)
        return True

    async def remember_guest(self, scope: str) -> None:
        """Standing grant: future sessions from this guest start approved.
        ``scope``: ``project`` (this session's project) or ``everywhere``."""
        from flow_sdk.builtin.contact_permission import ContactPermission, PermissionAction  # noqa: PLC0415

        if not self.guest_user_id:
            return
        project_id = self.project_id if scope == "project" else None
        rows = await ContactPermission.get_all({"contact_user_id": self.guest_user_id})
        row = next((r for r in rows if r.project_id == project_id), None)
        if row is None:
            row = ContactPermission(contact_user_id=self.guest_user_id, project_id=project_id)
        if PermissionAction.AUTO_APPROVE_SESSION.value not in (row.allowed_actions or []):
            row.allowed_actions = [*(row.allowed_actions or []), PermissionAction.AUTO_APPROVE_SESSION.value]
        await row.save()

    @action.post(action_name="approve")
    async def _http_approve(self) -> ApiResponse:
        """Host approves a PENDING live session and re-drives the prompts that
        queued while awaiting approval — detached, so the click returns
        immediately; ``prompt_auto_handled``-before-run keeps the re-drive
        idempotent against concurrently arriving prompts.

        Body: ``{remember?: "project" | "everywhere"}`` also writes the
        standing grant for this guest."""
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        ri = get_current_request_info()
        body = (await ri.get_post_data() or {}) if ri else {}
        remember = str(body.get("remember") or "").strip()
        if remember and remember not in ("project", "everywhere"):
            return ApiFailResponse(message="remember must be 'project' or 'everywhere'", status_code=400)
        if not await self.approve(via=ApprovedVia.MANUAL):
            return ApiFailResponse(message=f"illegal live-session transition: {self.status} → idle")
        if remember:
            await self.remember_guest(remember)
        import asyncio  # noqa: PLC0415

        from flow_sdk.app.actions.execute_prompt import redrive_session_prompts  # noqa: PLC0415
        asyncio.create_task(redrive_session_prompts(self))
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

    @action.post(action_name="settings")
    async def _http_settings(self) -> ApiResponse:
        """Edit session settings. Body: ``{reply_policy: "auto" | "review"}``.
        Host-authoritative: the change ships to the guest on the next carrier
        (a ``settings_changed`` line is emitted so it ships now)."""
        from flow_sdk.request_context.methods import get_current_request_info  # noqa: PLC0415

        ri = get_current_request_info()
        body = (await ri.get_post_data() or {}) if ri else {}
        raw = body.get("reply_policy")
        try:
            policy = ReplyPolicy(str(raw))
        except ValueError:
            return ApiFailResponse(message="reply_policy must be 'auto' or 'review'", status_code=400)
        if is_terminal(self.status):
            return ApiFailResponse(message="session has ended", status_code=409)
        if self.reply_policy != policy.value:
            self.reply_policy = policy.value
            self.mark_activity()
            await self.save()
            label = "auto-send" if policy is ReplyPolicy.AUTO else "review before sending"
            await self._emit_event("settings_changed", text=f"Replies: {label}")
        return ApiSuccessResponse(data=self.model_dump(mode="json"))

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
