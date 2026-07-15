"""Inbox unread reconciliation — the ONLY publisher of ``InboxManager.unread``.

Two functions, no repository framework:

* ``reconcile(reason)``     — full recompute from canonical rows → save iff changed.
* ``accept_mark_preview_read(...)`` — the invitation-accept transition (mark the
  *verified* preview read + the Invitation accepted), then reconcile.

The counting formula deliberately mirrors the frontend row facets
(``ui/src/components/conversation/conversation-category.ts`` ``conversationFacets``)
so the scalar and the rendered Unread list can never disagree:

    unread = active conversations whose latest pointer-backed message is
             unread-received (one per conversation; a pending conversation-
             invitation row always counts as one)
           + pending standalone (membership/entity-share) invitations

Never deltas — every reconcile recomputes from scratch, so duplicate hub
events, catch-up, retries, and restarts all converge to the same value.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.api.api_types.type_id import TypeId
    from flow_sdk.builtin.inbox_manager import InboxManager
    from flow_sdk.builtin.invitation import Invitation

logger = logging.getLogger(__name__)

# Serializes compute→compare→save so two concurrent reconciles can't interleave
# a stale save over a fresher one. Process-local is enough: the backend is the
# single writer of the projection.
_reconcile_lock = asyncio.Lock()


# ── viewer identity ──────────────────────────────────────────────────────────

def viewer_email() -> Optional[str]:
    """Normalized email of the active cloud account, or None when logged out.

    Invitations are addressed by recipient email; with no cloud account they
    cannot target this viewer and therefore never contribute.
    """
    try:
        from flow_sdk.cli.app_config import get_user  # noqa: PLC0415
        from flow_sdk.cli.auth.hub_login import is_logged_in  # noqa: PLC0415

        if not is_logged_in():
            return None
        user = get_user()
        email = (user or {}).get("email") if isinstance(user, dict) else None
        return email.strip().lower() if email else None
    except Exception:  # noqa: BLE001
        return None


# ── pointer / archive helpers ────────────────────────────────────────────────

def _pointers(conv) -> list[dict]:
    """Parse ``Conversation.message_ids`` (JSON list of ``{"typeid","ts"}``,
    oldest-first). Empty list on missing/corrupt projections."""
    if not conv.message_ids:
        return []
    try:
        ptrs = json.loads(conv.message_ids)
        return ptrs if isinstance(ptrs, list) else []
    except (json.JSONDecodeError, TypeError):
        return []


def _pointer_fm_id(ptr: dict) -> Optional[str]:
    """``flow_message-<id>`` → ``<id>`` with the local ``@`` marker stripped."""
    typeid = str(ptr.get("typeid") or "")
    if "-" not in typeid:
        return None
    ptype, pid = typeid.split("-", 1)
    return pid.lstrip("@") or None if ptype == "flow_message" else None


def _parse_ts(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def _is_effectively_archived(conv, latest_ts: Optional[datetime]) -> bool:
    """Conversation-level archive with auto-revive: hidden until a message
    NEWER than ``archived_at`` lands (same comparison as the FE facets —
    a missing/unparseable latest ts counts as not-revived)."""
    if conv.archived_at is None:
        return False
    if latest_ts is None:
        return True
    archived_at = conv.archived_at
    if latest_ts.tzinfo is None or archived_at.tzinfo is None:
        latest_ts, archived_at = latest_ts.replace(tzinfo=None), archived_at.replace(tzinfo=None)
    return latest_ts <= archived_at


# ── the count (pure core — REPL/table-testable with plain objects) ──────────

def invitation_is_pending(inv, viewer_email: Optional[str], now: datetime) -> bool:
    """Pending = unaccepted, unexpired (vs the injected clock), addressed to
    this viewer. No cloud account → nothing is pending for us."""
    if not viewer_email:
        return False
    if getattr(inv, "accepted", None) is True:
        return False
    expiration = getattr(inv, "expiration_at", None)
    if expiration is not None:
        if expiration.tzinfo is None:
            expiration = expiration.replace(tzinfo=now.tzinfo)
        if now > expiration:
            return False
    return (getattr(inv, "recipient_email", None) or "") == viewer_email


def count_unread(
    *,
    conversations,
    fm_by_id: dict,
    invitations,
    self_ids: set,
    viewer_email: Optional[str],
    now: datetime,
) -> int:
    """The unread formula — pure, over plain rows (the fetch lives in
    ``_compute_unread``). Mirrors the FE ``conversationFacets`` exactly:

        unread = active conversations whose latest pointer-backed message is
                 unread-received (a pending conversation-invite row is always
                 one actionable item)
               + pending standalone (membership/entity-share) invitations
    """
    pending = [inv for inv in invitations if invitation_is_pending(inv, viewer_email, now)]

    # Every pending invitation is one actionable unread item, counted DIRECTLY —
    # never through its conversation row. A conversation invite's placeholder
    # conversation may not be materialized yet (or has no pointer projection:
    # _materialize_invitation only inits the jsonl), and gating the count on
    # that state made a brand-new invitation invisible to the badge.
    # Membership invites (target_type/target_id) have no conversation at all.
    pending_conv_ids = {
        (inv.target_url_path or "").removeprefix("/conversation/")
        for inv in pending
        if not (getattr(inv, "target_type", None) and getattr(inv, "target_id", None))
        and (getattr(inv, "target_url_path", None) or "").startswith("/conversation/")
    }
    unread = len(pending)

    for conv in conversations:
        if conv.id in pending_conv_ids:
            # Already counted as the pending invitation — skip so the unread
            # preview message can't double-count the same item.
            continue
        ptrs = _pointers(conv)
        if not ptrs:
            continue
        if _is_effectively_archived(conv, _parse_ts(ptrs[-1].get("ts"))):
            continue
        latest = fm_by_id.get(_pointer_fm_id(ptrs[-1]) or "")
        if latest is None or getattr(latest, "is_draft", False):
            # Not materialized yet — don't fall back to an older message; the
            # post-materialization reconcile picks it up.
            continue
        if not latest.is_read and latest.sender_id and latest.sender_id not in self_ids:
            unread += 1

    return unread


async def _compute_unread() -> int:
    from datetime import timezone  # noqa: PLC0415

    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.invitation import Invitation  # noqa: PLC0415
    from flow_sdk.builtin.user import User  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    email = viewer_email()
    invitations = (
        await Invitation.get_all(QueryFilter(type=EntityType.INVITATION.value))
        if email
        else []
    )
    return count_unread(
        conversations=await Conversation.get_all(QueryFilter(type=EntityType.CONVERSATION.value)),
        fm_by_id={m.id: m for m in await FlowMessage.get_all(QueryFilter(type=EntityType.FLOW_MESSAGE.value))},
        invitations=invitations,
        self_ids=await User.self_ids(),
        viewer_email=email,
        now=datetime.now(timezone.utc),
    )


# ── public surface ───────────────────────────────────────────────────────────

async def reconcile(reason: str, owner: "TypeId | None" = None) -> "InboxManager":
    """Recompute ``InboxManager.unread`` and publish iff the value changed.

    Safe to call after ANY read-state mutation; cheap when nothing changed
    (no save, no data_op). Failure-isolated at call sites — a reconcile
    hiccup must never fail the mutation that triggered it.
    """
    from flow_sdk.builtin.inbox_manager import InboxManager  # noqa: PLC0415

    async with _reconcile_lock:
        manager = await InboxManager.get_local()
        unread = await _compute_unread()
        if manager.unread != unread:
            logger.info("[inbox] unread %d -> %d (%s)", manager.unread, unread, reason)
            manager.unread = unread
            await manager.save(owner, notify=True)
        return manager


async def accept_mark_preview_read(
    invitation: "Invitation",
    *,
    conversation_id: Optional[str] = None,
    linked_fm_id: Optional[str] = None,
    owner: "TypeId | None" = None,
) -> None:
    """The invitation-accept read transition. Idempotent (repeat / 409 accepts).

    Marks the invitation's preview FlowMessage read ONLY when verified — the
    candidate must be ``kind=invitation`` AND reference ``invitation-<id>`` in
    its context entities. Never marks by ordering alone: if nothing verifies,
    mark nothing and let the next reconcile repair the projection. Membership
    invitations have no preview — only the accepted flag applies.
    """
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage, FlowMessageKind  # noqa: PLC0415

    inv_ref = f"invitation-{invitation.id}"

    def _verified(fm) -> bool:
        if fm is None or fm.kind != FlowMessageKind.INVITATION:
            return False
        contexts = (getattr(fm, "shared_context_entities", None) or []) + (
            getattr(fm, "context_entities", None) or []
        )
        return any(inv_ref in str(c) for c in contexts)

    preview = None
    if linked_fm_id:
        candidate = await FlowMessage.get_by_id(linked_fm_id)
        if _verified(candidate):
            preview = candidate
    if preview is None and conversation_id:
        conv = await Conversation.get_by_id(conversation_id)
        if conv is not None:
            ptrs = _pointers(conv)
            first_id = _pointer_fm_id(ptrs[0]) if ptrs else None
            if first_id:
                candidate = await FlowMessage.get_by_id(first_id)
                if _verified(candidate):
                    preview = candidate

    if preview is not None and not preview.is_read:
        preview.is_read = True
        await preview.save(owner, notify=True)
    elif preview is None and (linked_fm_id or conversation_id):
        logger.info(
            "[inbox] accept %s: no verified preview (fm=%s conv=%s) — leaving read state untouched",
            invitation.id, linked_fm_id, conversation_id,
        )

    if invitation.accepted is not True:
        invitation.accepted = True
        await invitation.save(owner, notify=True)

    await reconcile(f"invitation-accept:{invitation.id}", owner)
