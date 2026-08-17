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

**Why the count lives here and not on each message.** The conversation view
loads a bounded window of messages (``CONVERSATION_MESSAGES_WINDOW``, 500) with
no pagination, so counting a thread client-side is silently wrong for any real
mailbox. One row per thread, one writer, counted from the store.

Tier B: no placement fields, so the indexer can never walk it; written only by
the inbox projector.
"""
from __future__ import annotations

from typing import ClassVar, FrozenSet

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.core import Entity
from flow_sdk.core.entity.projected_fields import ProjectedFields
from flow_sdk.schema.types import EntityType


class MessageThread(ProjectedFields, Entity):
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

    # ── projection — derived from the messages carrying this thread's id ───
    # Written only by `recompute_thread_projection` (inbox/projection.py); the
    # ProjectedFields guard refuses a direct assignment.
    message_count: int = APIField(default=0, sharing=Sharing.PRIVATE)

    projected_fields: ClassVar[FrozenSet[str]] = frozenset({"message_count"})
    projection_writer: ClassVar[str] = "recompute_thread_projection"
    _api_visible: ClassVar[bool] = True

    @staticmethod
    def allocate_deterministic_id(channel: str, thread_key: str) -> str:
        """v5 id from (channel, thread key) — derived, never looked up."""
        return mint_uuid(f"message_thread:{channel}:{thread_key}")
