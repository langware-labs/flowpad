"""Inbox unread projection — the ONLY publisher of ``InboxManager.unread``.

The whole surface, no repository framework:

* ``touch(reason)``            — what every mutation site calls: one line,
  fire-and-forget, failure-isolated recompute+publish.
* ``recompute_unread(reason)`` — the awaited form (bootstrap/startup repair,
  accept transition): full recompute from canonical rows → save iff changed.
* ``accept_mark_preview_read(...)`` — the invitation-accept transition (mark the
  *verified* preview read + the Invitation accepted), then recompute.
* ``count_unread(...)`` / ``invitation_is_pending(...)`` — the pure formula
  (table-tested, no DB). Conversation-domain rules (pointer parsing, archive
  auto-revive) live on the ``Conversation`` entity itself
  (``message_refs()`` / ``is_archived()``), not here.

The counting formula deliberately mirrors the frontend row facets
(``ui/src/components/conversation/conversation-category.ts`` ``conversationFacets``)
so the scalar and the rendered Unread list can never disagree:

    unread = pending invitations (conversation + membership, one each)
           + active conversations whose latest pointer-backed message is
             unread-received (one per conversation; invite-pending
             conversations are excluded — already counted via the invitation)

Never deltas — every recompute starts from scratch, so duplicate hub events,
catch-up, retries, and restarts all converge to the same value.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from flow_sdk.inbox._locks import loop_lock, new_registry

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.fs_store.type_id import TypeId
    from flow_sdk.builtin.inbox_manager import InboxManager
    from flow_sdk.builtin.invitation import Invitation

logger = logging.getLogger(__name__)

# Serializes compute→compare→save so two concurrent recomputes can't interleave
# a stale save over a fresher one. Process-local is enough: the backend is the
# single writer of the projection. Per running event loop — see ``_locks`` for
# why a module-global Lock breaks under per-test loops.
_recompute_locks = new_registry()


def _recompute_lock() -> asyncio.Lock:
    return loop_lock(_recompute_locks)


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


# ── the formula (pure — REPL/table-testable with plain objects) ─────────────

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
    """The unread formula — pure, over entity rows (the fetch lives in
    ``_load_and_count``). Mirrors the FE ``conversationFacets`` exactly."""
    from flow_sdk.inbox.projection import is_agent_sender  # noqa: PLC0415

    pending = [inv for inv in invitations if invitation_is_pending(inv, viewer_email, now)]

    # Every pending invitation is one actionable unread item, counted DIRECTLY —
    # never through its conversation row. A conversation invite's placeholder
    # conversation may not be materialized (or has no pointer projection yet),
    # and gating on that state made a brand-new invitation invisible.
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
        ref = conv.latest_message_ref()
        if ref is None:
            continue
        if conv.is_archived():
            continue
        # NEWEST by timestamp, not last-appended: an ingested mailbox hands
        # its history back newest-first, so `refs[-1]` there is the OLDEST
        # mail and the conversation reads as read when it isn't.
        latest = fm_by_id.get(ref.id)
        if latest is None or getattr(latest, "is_draft", False):
            # Not materialized yet — don't fall back to an older message; the
            # post-materialization recompute picks it up.
            continue
        # An agent's reply is OURS, not unread mail from a stranger — and the
        # `agent:` prefix says so by itself. Enumerating agent rows to build the
        # set instead would run a table scan per recount AND give a different
        # answer over time: an agent whose mail is later switched off would drop
        # out, and its past replies would start counting as unread.
        if (
            not latest.is_read
            and latest.sender_id
            and latest.sender_id not in self_ids
            and not is_agent_sender(latest.sender_id)
        ):
            unread += 1

    return unread


async def _load_and_count() -> int:
    """Fetch the canonical rows and run the pure formula over them."""
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
        # hydrate=False: the formula reads is_read/sender/is_draft, never text —
        # joining every reference row's SourceItem here would put a whole-mailbox
        # join on every mutation's recompute.
        fm_by_id={m.id: m for m in await FlowMessage.get_all(
            QueryFilter(type=EntityType.FLOW_MESSAGE.value), hydrate=False
        )},
        invitations=invitations,
        self_ids=await User.self_ids(),
        viewer_email=email,
        now=datetime.now(timezone.utc),
    )


_INBOX_STARTED = False


def start_inbox() -> None:
    """Arm every inbox lane, in the order they depend on each other.

    ONE entry point because the order is a contract, not a preference: the agent
    runner keys off `inbox.*.message.projected`, which only the projection
    emits, so a process that armed the runner alone ingests mail and answers
    nothing. Stating that once here means a caller cannot get it wrong, and a
    third lane added later reaches every caller — where two hand-ordered call
    sites would leave the second one silently half-wired.

    Idempotent, and it has to own that itself: `start_inbox_projection` carries
    its own `_started` guard but `subscribe()` is a plain `on_tag` that returns
    an unsubscriber, so arming twice would attach the runner twice and every
    message would drive two turns.
    """
    global _INBOX_STARTED
    if _INBOX_STARTED:
        return
    _INBOX_STARTED = True

    from flow_sdk.inbox.agent_runner import subscribe as subscribe_agent_mail  # noqa: PLC0415
    from flow_sdk.inbox.projection import start_inbox_projection  # noqa: PLC0415

    start_inbox_projection()
    subscribe_agent_mail()


# ── public surface ───────────────────────────────────────────────────────────

def touch(reason: str) -> None:
    """THE one call a mutation site makes after changing read-state.

    Fire-and-forget: schedules :func:`recompute_unread` as a detached task,
    fully failure-isolated — a projection hiccup can never fail or slow the
    mutation that triggered it. Call sites need exactly this one line (no
    await, no try/except, no local import ceremony):

        inbox.touch("inbox-update")

    Use the awaited :func:`recompute_unread` directly only where the caller
    must observe the fresh value before proceeding (bootstrap/startup repair).
    """
    async def _run() -> None:
        try:
            await recompute_unread(reason)
        except Exception:  # noqa: BLE001
            logger.warning("[inbox] recompute failed (%s)", reason, exc_info=True)

    try:
        asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        # No running loop (sync/startup context) — the bootstrap/startup
        # repair recompute converges the projection.
        logger.debug("[inbox] touch(%s) skipped — no running event loop", reason)


async def recompute_unread(reason: str, owner: "TypeId | None" = None) -> "InboxManager":
    """Recompute ``InboxManager.unread`` from canonical rows and publish iff
    the value changed (at most one entity UPDATE per call; cheap when nothing
    changed). Mutation call sites should use :func:`touch` instead — this
    awaited form is for callers that need the fresh value."""
    from flow_sdk.builtin.inbox_manager import InboxManager  # noqa: PLC0415

    async with _recompute_lock():
        manager = await InboxManager.get_local()
        unread = await _load_and_count()
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
    mark nothing and let the next recompute repair the projection. Membership
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
        refs = conv.message_refs() if conv is not None else []
        if refs:
            candidate = await FlowMessage.get_by_id(refs[0].id)
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

    await recompute_unread(f"invitation-accept:{invitation.id}", owner)
