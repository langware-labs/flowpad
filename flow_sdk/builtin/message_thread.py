"""MessageThread — one thread of cloud messages, and the seam that lets a
conversation hold more than one of them.

A Gmail thread, a Slack ``thread_ts``, a Jira issue's comment list: each is one
row here. ``conversation_id`` is MANY-to-one, which is the entire point —
merging two threads is repointing that one field, so no id ever changes and no
FlowMessage reference dangles. (Contrast the obvious alternative, deriving the
conversation id from the thread key: correct until the first merge, then
unrecoverable.)

**Identity is derived, so nothing has to look it up.**
``mint_uuid(f"message_thread:{channel}:{thread_key}")`` — the projector knows a
message's thread id from the message alone, and a re-poll converges on the same
row. Keyed on CHANNEL, not provider: a Gmail thread ingested through the
harness transport today and the API transport tomorrow must resolve to ONE
thread (see ``cloud_origin.CloudOrigin``).

**Why the counters live here and not on each message.** The conversation view
loads a bounded window of messages (``CONVERSATION_MESSAGES_WINDOW``, 500) with
no pagination, so counting a thread client-side is silently wrong for any real
mailbox. One row per thread, one writer, counted from the store.

Tier B: no placement fields, so the indexer can never walk it; written only by
the inbox projector.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

# Projection guard — the ``Conversation.message_ids`` pattern. These three are
# derived from the FlowMessages that carry this thread's id; application code
# must go through ``recompute_thread_projection`` (inbox/projection.py), never
# assign them.
_PROJECTION_SENTINEL = object()

_PROJECTED_FIELDS = frozenset({"message_count", "head_message_id", "last_message_at"})


class MessageThread(Entity):
    type: str = APIField(default=EntityType.MESSAGE_THREAD.value)

    # ── identity ───────────────────────────────────────────────────────────
    # The channel: gmail | slack | jira. Half of the deterministic id.
    channel: str = APIField(default="")
    # The provider's own thread handle — Gmail `threadId`, Slack `thread_ts`,
    # `ISSUE-123`, or a normalized subject where the provider offers nothing
    # better. Stored (not just hashed into the id) so a mis-threaded row is
    # debuggable and so a future re-keying can find its inputs.
    thread_key: str = APIField(default="")

    # ── the many-to-one seam ───────────────────────────────────────────────
    # Which conversation shows this thread. Starts 1:1 with a freshly minted
    # conversation; a manual merge repoints it. THE only field a merge writes.
    conversation_id: str = APIField(default="")

    # Human label — the email subject, `#channel › thread`. Kept separate from
    # the conversation's title, which after a merge names several threads.
    title: str = APIField(default="")

    # ── projections — see the guard below ──────────────────────────────────
    message_count: int = APIField(default=0, sharing=Sharing.PRIVATE)
    # The newest message: what the packed row renders without loading the rest.
    head_message_id: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)
    last_message_at: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)

    _api_visible: ClassVar[bool] = True

    @staticmethod
    def allocate_deterministic_id(channel: str, thread_key: str) -> str:
        """v5 id from (channel, thread key) — derived, never looked up."""
        return mint_uuid(f"message_thread:{channel}:{thread_key}")

    def __setattr__(self, key, value):
        if (
            key in _PROJECTED_FIELDS
            and not self.__dict__.get("_allow_projection_write", False)
        ):
            raise AttributeError(
                f"MessageThread.{key} is a projection — write via "
                f"recompute_thread_projection, not directly"
            )
        return super().__setattr__(key, value)

    def apply_field_updates(self, fields: dict):
        """Silently drop projection fields from inbound PUT/PATCH bodies.

        A client save round-trips the whole entity dump, which includes the
        counters. Re-applying identical values would be a no-op, but the guard
        refuses any direct write — so strip them here rather than making the
        guard leaky. Same reasoning as ``Conversation.apply_field_updates``.
        """
        if fields:
            fields = {k: v for k, v in fields.items() if k not in _PROJECTED_FIELDS}
        return super().apply_field_updates(fields)

    def _set_projection(self, key: str, value, sentinel) -> None:
        """Internal projection writer used by the inbox projector."""
        if sentinel is not _PROJECTION_SENTINEL:
            raise PermissionError("invalid projection sentinel")
        object.__setattr__(self, "_allow_projection_write", True)
        try:
            setattr(self, key, value)
        finally:
            object.__setattr__(self, "_allow_projection_write", False)
