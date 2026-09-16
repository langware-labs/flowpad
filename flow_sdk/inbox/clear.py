"""Drop the hub's copy of the inbox from this machine.

Logout has always cleared the CREDENTIALS and nothing else, so everything the
hub pulled onto the disk outlived the session it belonged to: conversations,
their messages, the org rows ``materialize_remote_organization`` writes at
login. Nothing scopes an inbox read by the logged-in account, so the next
account to log into the same instance inherited the previous one's inbox.

**The type list below is an allowlist, and that is the safety property — do not
generalize it to "every row with ``remote=True``".** ``remote`` means "this row
has a hub counterpart at the same id", which is broader than "the hub put this
here": ``share_action`` stamps it on the user's OWN Project/Task/Agent/Wiki when
they share one (so ``handle_add_message`` treats the entity as hub-bound), and
``hub_bridge`` stamps it on generically-materialized children of any type. A
purge that keyed off the flag alone would delete the user's own shared projects.
Only the types named here are ones the hub alone ever puts on this disk.

Within those types the flag still does the scoping, and it deliberately spares
the rest of the inbox: a conversation projected from a connected gmail/slack
source is ``remote=False``, its source is still authenticated after a hub
logout, and its consumer position has already advanced past those items —
deleting the projection would leave a hole nothing ever refills.

Messages are keyed off the CONVERSATION, not off their own ``remote`` flag. A
message queued while offline (``DeliveryStatus.PENDING_SEND``) has never
reached the hub and so is ``remote=False``, but it is addressed to a hub thread
and is the user's own content awaiting a session — it goes with the
conversation it belongs to rather than being stranded on a machine whose owner
has logged out.

Called only from an EXPLICIT logout, via ``clear_user_data``. The involuntary
paths (an expired token, a hub-rejected key) keep clearing credentials alone —
see the note on ``clear_cloud_credentials``.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


async def _destroy_all(rows) -> int:
    """``destroy()`` every row, surviving a failure on any one of them.

    ``destroy`` (not ``delete``) so the record folder goes with the row, and so
    ``FlowMessage.destroy`` gets to run its ``_purge_local_data`` — which also
    takes that message's ``MessageAttachment`` rows and staging bytes, which is
    why attachments need no pass of their own. One unlucky row must not strand
    the rest: a partial purge that logs beats an abandoned one that doesn't.
    """
    destroyed = 0
    for row in rows:
        try:
            await row.destroy()
            destroyed += 1
        except Exception:  # noqa: BLE001
            logger.warning("[inbox] clear: failed to destroy %s", getattr(row, "typeid", row), exc_info=True)
    return destroyed


async def clear_inbox() -> None:
    """Delete the hub-derived inbox.

    Idempotent — a second pass finds nothing and does nothing. Worth having:
    the disconnect action and ``POST /logout`` are two doors onto the same
    intent, and a double-submit must not be a second, noisier purge.
    """
    from flow_sdk.app.actions.flow_message_action import _hard_delete_local_conversation  # noqa: PLC0415
    from flow_sdk.builtin.collaboration_room import CollaborationRoom  # noqa: PLC0415
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.builtin.group import Group  # noqa: PLC0415
    from flow_sdk.builtin.invitation import Invitation  # noqa: PLC0415
    from flow_sdk.builtin.message_thread import MessageThread  # noqa: PLC0415
    from flow_sdk.builtin.organization import Organization  # noqa: PLC0415
    from flow_sdk.builtin.team import Team  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_bridge import hub_ws_bridge  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.inbox import recompute_unread  # noqa: PLC0415

    conversations = await Conversation.get_all({"remote": True})
    conversation_ids = [str(c.id) for c in conversations if c.id]
    removed = 0

    if conversation_ids:
        # One query per child type, not one per conversation: ``conversation_id``
        # lives in the JSON blob with no index, so a per-conversation lookup is a
        # full scan of that type's partition — 2×N scans where 2 do.
        #
        # A FRESH filter per call, never a shared one: ``get_all`` stamps
        # ``entities_filter.type`` onto the object in place, so a second class
        # reusing it would silently re-query the first class's type.
        def in_conversation() -> QueryFilter:
            return QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["conversation_id", conversation_ids]))

        # ``hydrate=False``: hydration stitches each body back from its
        # SourceItem, and these bodies are about to be deleted.
        removed += await _destroy_all(await FlowMessage.get_all(in_conversation(), hydrate=False))
        removed += await _destroy_all(await MessageThread.get_all(in_conversation()))

    for conversation in conversations:
        # The canonical local teardown — it unlinks the on-disk ``conversation.jsonl``
        # pointer index, which lives under records_DATA and so is NOT covered by the
        # row's own record-folder removal. Its message sweep finds nothing left; the
        # suppression is what every other delete path takes, so a hub child still in
        # flight can't rematerialize the parent we just removed.
        # ``session_scoped``: this conversation is not deleted, only signed out of —
        # it still exists on the hub, so the next login releases this tombstone.
        hub_ws_bridge.suppress_conversation_materialization(str(conversation.id), session_scoped=True)
        await _hard_delete_local_conversation(conversation)
    removed += len(conversations)

    for cls in (Organization, Team, Group, Invitation, CollaborationRoom):
        removed += await _destroy_all(await cls.get_all({"remote": True}))

    if removed:
        logger.info("[inbox] clear: removed %d hub-derived row(s)", removed)
        # Only when something went: local conversations survive and can still be
        # unread, so this is a real recount, not a write of a known 0 — and on the
        # idempotent second pass the ``logged_out`` touch already covers it.
        await recompute_unread("logout")
