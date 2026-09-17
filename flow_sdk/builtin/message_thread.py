"""MessageThread — one thread of cloud messages, and the seam that lets a
conversation hold more than one of them.

A Gmail thread, a Slack ``thread_ts``, a Jira issue's comment list: each is one
row here. ``conversation_id`` is MANY-to-one, which is the entire point —
merging two threads is repointing that one field, so no id ever changes and no
FlowMessage reference dangles. (Contrast the obvious alternative, deriving the
conversation id from the thread key: correct until the first merge, then
unrecoverable.)

**Identity is the natural key, looked up — not derived.** ``find_existing``
resolves ``(channel, thread_key, owner, data_source_id)`` to the row that already
holds it (the key is declared once, in ``TypeInfo.natural_key``); the id itself is
an ordinary uuid4 minted on first sight. A re-poll converges on one row by lookup,
so fixing a channel value is an UPDATE of the key columns, never a re-mint that
orphans read state.

**A thread belongs to the account that read it.** ``data_source_id`` is that account
as the source reads it: without it two mailboxes of one owner on one channel resolve
the same ``(channel, thread_key)`` whenever their keys match — always, for a provider
that threads by subject — and ``Re: invoice`` from work and from personal mail become
one conversation. The source row, not its ``account_key``, because that value is
re-stamped when a source first verifies and a key built on it would fork every thread
it had. The same mailbox read through two transports (the Gmail API and a harness
connector) stays two threads: their thread ids are different encodings and their
message ids different schemes, so no key could honestly merge them.

**Why the count lives here and not on each message.** The conversation view
loads a bounded window of messages (``CONVERSATION_MESSAGES_WINDOW``, 500) with
no pagination, so counting a thread client-side is silently wrong for any real
mailbox. One row per thread, one writer, counted from the store.

Tier B: no placement fields, so the indexer can never walk it; written only by
the stream inbox projector.
"""
from __future__ import annotations

from typing import ClassVar, FrozenSet, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.entity.projected_fields import ProjectedFields
from flow_sdk.fs_store.type_id import TypeId
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
    # Whose stream inbox this thread belongs to — the local user's or an Agent's. The
    # third half of the natural key: without it two owners watching the same
    # channel resolve the same `(channel, thread_key)` and their conversations
    # merge. `None` on rows written before the field existed; the projection
    # adopts those into the resolving owner on first touch rather than forking.
    owner: Optional[TypeId] = APIField(default=None, sharing=Sharing.PRIVATE)
    # The source that read this thread — the account half of the natural key (see the
    # module docstring). `None` on rows written before the field existed; the projection
    # adopts those into the first source that resolves them rather than forking.
    data_source_id: Optional[str] = APIField(default=None, sharing=Sharing.PRIVATE)

    # ── the many-to-one seam ───────────────────────────────────────────────
    # Which conversation shows this thread. Starts 1:1 with a freshly minted
    # conversation; a manual merge repoints it. THE only field a merge writes.
    conversation_id: str = APIField(default="")

    # Human label — the email subject, `#channel › thread`. Kept separate from
    # the conversation's title, which after a merge names several threads.
    title: str = APIField(default="")

    # ── projection — derived from the messages carrying this thread's id ───
    # Written only by `recompute_thread_projection` (stream_inbox/projection.py); the
    # ProjectedFields guard refuses a direct assignment.
    message_count: int = APIField(default=0, sharing=Sharing.PRIVATE)

    projected_fields: ClassVar[FrozenSet[str]] = frozenset({"message_count"})
    projection_writer: ClassVar[str] = "recompute_thread_projection"
    _api_visible: ClassVar[bool] = True

    @classmethod
    async def find_existing(
        cls, channel: str, thread_key: str, owner: "TypeId | None", data_source_id: str
    ) -> "MessageThread | None":
        """THE identity lookup — the row for this natural key, or None.

        The key is declared once, on the type (``TypeInfo.natural_key``); this
        is its named single-row entry point, indexed by
        ``ix_entities_message_thread_natural_key_v3``. Same shape as
        ``SourceItem.find_existing``.
        """
        match: dict = {"channel": channel, "thread_key": thread_key, "data_source_id": str(data_source_id)}
        if owner is not None:
            match["owner"] = str(owner)
        return await cls.get_one(match)

    @classmethod
    async def find_unclaimed(cls, channel: str, thread_key: str, owner: "TypeId | None") -> "MessageThread | None":
        """A row for this key written before its account (or owner) was part of the key.

        Exactly ``data_source_id IS NULL``, and owned by ``owner`` or by nobody — NOT
        "any row on this key": the projection adopts it into the source and owner that
        resolve it, and must never claim another account's or another owner's thread.
        The owner's own row is preferred over an unowned one.
        """
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        def legacy(owned: ExpressionNode) -> QueryFilter:
            return QueryFilter(
                match=ExpressionNode(
                    op=QueryOp.AND,
                    operands=[
                        ExpressionNode(op=QueryOp.EQ, operands=["channel", channel]),
                        ExpressionNode(op=QueryOp.EQ, operands=["thread_key", thread_key]),
                        ExpressionNode(op=QueryOp.IS_NULL, operands=["data_source_id"]),
                        owned,
                    ],
                )
            )

        if owner is not None:
            mine = await cls.get_one(legacy(ExpressionNode(op=QueryOp.EQ, operands=["owner", str(owner)])))
            if mine is not None:
                return mine
        return await cls.get_one(legacy(ExpressionNode(op=QueryOp.IS_NULL, operands=["owner"])))
