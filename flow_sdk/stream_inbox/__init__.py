"""Stream inbox unread projection — the ONLY publisher of ``StreamInboxManager.unread``.

The whole surface, no repository framework:

* ``touch(reason)``            — what every mutation site calls: one line,
  fire-and-forget, failure-isolated recompute+publish.
* ``recompute_unread(reason)`` — the awaited form (bootstrap/startup repair,
  accept transition): full recompute from canonical rows → save iff changed.
* ``accept_mark_preview_read(...)`` — the invitation-accept transition (mark the
  *verified* preview read + the Invitation accepted), then recompute.
* ``conversation_is_unread(...)`` / ``project_unread(...)`` / ``invitation_is_pending(...)`` —
  the pure formula (table-tested, no DB). Conversation-domain rules (pointer parsing,
  archive auto-revive) live on the ``Conversation`` entity itself
  (``message_refs()`` / ``is_archived()``), not here.

The backend owns unread, and says it twice from one rule so the two can never disagree:
each conversation's ``Conversation.is_unread`` (what a row renders — the frontend reads it,
it does not recompute it) and the badge scalar ``StreamInboxManager.unread``:

    unread = pending invitations (conversation + membership, one each)
           + conversations IN THE LOCAL USER'S STREAM INBOX (owner is the local user, or
             unowned) that are not archived and whose latest pointer-backed message is
             unread-received (one per conversation; invite-pending conversations are
             excluded — already counted via the invitation)

An Agent's stream inbox is its own: its mail never counts on the user's badge.

Never deltas — every recompute starts from scratch, so duplicate hub events,
catch-up, retries, and restarts all converge to the same value.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Optional

from flow_sdk.stream_inbox._locks import loop_lock, new_registry

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.invitation import Invitation
    from flow_sdk.builtin.stream_inbox_manager import StreamInboxManager
    from flow_sdk.fs_store.type_id import TypeId

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


def pending_conversation_ids(pending) -> set[str]:
    """The conversations the pending invitations point at. Membership invites
    (``target_type``/``target_id``) have no conversation at all."""
    return {
        (inv.target_url_path or "").removeprefix("/conversation/")
        for inv in pending
        if not (getattr(inv, "target_type", None) and getattr(inv, "target_id", None))
        and (getattr(inv, "target_url_path", None) or "").startswith("/conversation/")
    }


def conversation_is_unread(conv, latest, *, pending_conv_ids: set, self_ids: set) -> bool:
    """THE per-conversation unread rule — what a row shows and what the badge counts.

    A pending invitation is always unread: it carries an action. Otherwise the conversation
    is unread when its latest message (``latest``, resolved newest-by-timestamp by the
    caller) was received and not read. Not materialized yet, or a draft, is not unread —
    the post-materialization recompute picks it up rather than falling back to an older
    message. "Received" is the typed sender: not ours by ``MessageSender.authored_by`` —
    one of our user ids, or an Agent we host (an agent's reply is OURS, whether or not its
    mail is still switched on). A message naming nobody is not unread.
    """
    if conv.id in pending_conv_ids:
        return True
    if latest is None or getattr(latest, "is_draft", False):
        return False
    return bool(not latest.is_read and latest.sender and not latest.sender.authored_by(self_ids))

def in_stream_inbox_of(conv, owner) -> bool:
    """Whether ``conv`` is listed in ``owner``'s stream inbox. A row written before
    ``owner`` existed is the local user's (``owner_of``'s rule), so it counts for the
    user whose typeid is passed as the local owner."""
    return conv.owner is None or (owner is not None and str(conv.owner) == str(owner))


@dataclass(frozen=True)
class UnreadProjection:
    """What one recompute says: the badge count and every conversation's flag."""

    total: int
    by_conversation: dict


def project_unread(
    *,
    conversations,
    fm_by_id: dict,
    invitations,
    self_ids: set,
    viewer_email: Optional[str],
    now: datetime,
    stream_inbox_owner=None,
) -> UnreadProjection:
    """The unread formula — pure, over entity rows (the fetch lives in ``_load_rows``).

    The COUNT covers ``stream_inbox_owner``'s stream inbox — conversations it owns, and unowned
    ones (rows written before ``owner`` existed are the local user's); the flags are
    computed for every conversation regardless. ``None`` (an instance that has not
    bootstrapped its local user) counts the unowned rows only, never another owner's.
    """
    pending = [inv for inv in invitations if invitation_is_pending(inv, viewer_email, now)]
    # Every pending invitation is one actionable unread item, counted DIRECTLY —
    # never through its conversation row. A conversation invite's placeholder
    # conversation may not be materialized (or has no pointer projection yet),
    # and gating on that state made a brand-new invitation invisible.
    pending_ids = pending_conversation_ids(pending)
    total = len(pending)
    flags: dict = {}
    for conv in conversations:
        # NEWEST by timestamp, not last-appended: an ingested mailbox hands
        # its history back newest-first, so `refs[-1]` there is the OLDEST
        # mail and the conversation reads as read when it isn't.
        ref = conv.latest_message_ref()
        latest = fm_by_id.get(ref.id) if ref is not None else None
        unread = conversation_is_unread(conv, latest, pending_conv_ids=pending_ids, self_ids=self_ids)
        flags[conv.id] = unread
        if not unread or conv.id in pending_ids or conv.is_archived():
            continue  # a pending invite is already counted; an archived row counts nothing
        if not in_stream_inbox_of(conv, stream_inbox_owner):
            continue
        total += 1
    return UnreadProjection(total=total, by_conversation=flags)


def count_unread(**rows) -> int:
    """The badge count alone — :func:`project_unread` for callers that need only the number."""
    return project_unread(**rows).total


async def _load_rows() -> tuple[list, dict]:
    """The canonical rows the formula reads: every conversation, and the keyword
    arguments :func:`project_unread` takes (the local user's stream inbox as the count scope)."""
    from datetime import timezone  # noqa: PLC0415

    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.invitation import Invitation  # noqa: PLC0415
    from flow_sdk.builtin.user import User  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import default_owner  # noqa: PLC0415

    email = viewer_email()
    conversations = await Conversation.get_all(QueryFilter(type=EntityType.CONVERSATION.value))
    return conversations, dict(
        conversations=conversations,
        # hydrate=False: the formula reads is_read/sender/is_draft, never text —
        # joining every reference row's SourceItem here would put a whole-mailbox
        # join on every mutation's recompute.
        fm_by_id={m.id: m for m in await FlowMessage.get_all(
            QueryFilter(type=EntityType.FLOW_MESSAGE.value), hydrate=False
        )},
        invitations=(
            await Invitation.get_all(QueryFilter(type=EntityType.INVITATION.value)) if email else []
        ),
        self_ids=await User.self_ids(),
        viewer_email=email,
        now=datetime.now(timezone.utc),
        stream_inbox_owner=await default_owner(),
    )


_STREAM_INBOX_STARTED = False


def start_stream_inbox() -> None:
    """Arm every stream inbox lane, in the order they depend on each other.

    ONE entry point because the order is a contract, not a preference: the agent
    runner keys off `stream_inbox.*.message.projected`, which only the projection
    emits, so a process that armed the runner alone ingests mail and answers
    nothing. Stating that once here means a caller cannot get it wrong, and a
    third lane added later reaches every caller — where two hand-ordered call
    sites would leave the second one silently half-wired.

    Idempotent, and it has to own that itself: `start_stream_inbox_projection` carries
    its own `_started` guard but `subscribe()` is a plain `on_tag` that returns
    an unsubscriber, so arming twice would attach the runner twice and every
    message would drive two turns.
    """
    global _STREAM_INBOX_STARTED
    if _STREAM_INBOX_STARTED:
        return
    _STREAM_INBOX_STARTED = True

    from flow_sdk.stream_inbox.agent_runner import subscribe as subscribe_agent_mail  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import start_stream_inbox_projection  # noqa: PLC0415

    start_stream_inbox_projection()
    subscribe_agent_mail()


# ── public surface ───────────────────────────────────────────────────────────

def touch(reason: str) -> None:
    """THE one call a mutation site makes after changing read-state.

    Fire-and-forget: schedules :func:`recompute_unread` as a detached task,
    fully failure-isolated — a projection hiccup can never fail or slow the
    mutation that triggered it. Call sites need exactly this one line (no
    await, no try/except, no local import ceremony):

        stream_inbox.touch("stream-inbox-update")

    Use the awaited :func:`recompute_unread` directly only where the caller
    must observe the fresh value before proceeding (bootstrap/startup repair).
    """
    async def _run() -> None:
        try:
            await recompute_unread(reason)
        except Exception:  # noqa: BLE001
            logger.warning("[stream-inbox] recompute failed (%s)", reason, exc_info=True)

    try:
        asyncio.get_running_loop().create_task(_run())
    except RuntimeError:
        # No running loop (sync/startup context) — the bootstrap/startup
        # repair recompute converges the projection.
        logger.debug("[stream-inbox] touch(%s) skipped — no running event loop", reason)


async def recompute_unread(reason: str, owner: "TypeId | None" = None) -> "StreamInboxManager":
    """Recompute unread from canonical rows and publish what changed: each conversation
    whose ``is_unread`` flipped, and ``StreamInboxManager.unread`` iff the count moved.
    Cheap when nothing changed — no save, no broadcast. Mutation call sites should use
    :func:`touch` instead — this awaited form is for callers that need the fresh value."""
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.stream_inbox_manager import StreamInboxManager  # noqa: PLC0415
    from flow_sdk.core.entity.projected_fields import PROJECTION_SENTINEL  # noqa: PLC0415

    async with _recompute_lock():
        manager = await StreamInboxManager.get_local()
        conversations, rows = await _load_rows()
        projection = project_unread(**rows)
        for conv in conversations:
            flag = projection.by_conversation[conv.id]
            if bool(conv.is_unread) == flag:
                continue
            # Stamp a FRESH read, never the snapshot the count was taken from: between that
            # load and this save another writer may have archived, repointed or deleted the
            # row, and saving the snapshot would undo the first two and resurrect the third.
            fresh = await Conversation.get_by_id(conv.id)
            if fresh is None or bool(fresh.is_unread) == flag:
                continue
            fresh._set_projection("is_unread", flag, PROJECTION_SENTINEL)
            await fresh.save(None, notify=True)
        if manager.unread != projection.total:
            logger.info("[stream-inbox] unread %d -> %d (%s)", manager.unread, projection.total, reason)
            manager.unread = projection.total
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
            "[stream-inbox] accept %s: no verified preview (fm=%s conv=%s) — leaving read state untouched",
            invitation.id, linked_fm_id, conversation_id,
        )

    if invitation.accepted is not True:
        invitation.accepted = True
        await invitation.save(owner, notify=True)

    await recompute_unread(f"invitation-accept:{invitation.id}", owner)
