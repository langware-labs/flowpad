"""``Delivered`` — one item a listener handed you, and the handle to say you are done with it.

Not a value. The item inside is the frozen ``SourceItemSpec`` (or a ``FolderChange``) and stays
one; this is the envelope around it — the ``MessageRequest`` role, except that it holds a
position and a source, which are not values. Attribute reads fall through to the item, so
``agent.process_message(m)`` takes the envelope unchanged. Reach for ``.item`` when you want
the value itself.

**Build a reply with ``m.reply_spec(body=…)`` unless the code already knows its channel.**
Naming a spec class is picking the addressing rule by hand; ``DataSource.reply_spec`` says
what that costs on the wrong channel.

**``ack()`` is an offset.** It commits this item AND everything before it — the Kafka grain,
settled deliberately, because per-item bookkeeping does not survive a consumer that fans out.
Call it after the effect, never before: a crash between handling and ack redelivers the
item, which is the at-least-once contract; a crash between ack and handling loses it, which
is the bug ``listen()`` exists to remove.

**``redelivered``** is True when this item was handed out before and never acked — the
consumer was mid-way through it when the process died. A handler whose effect is not
idempotent (a send) reads it before acting; ``reply()`` does.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Generic, TypeVar

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.consumer_position import ConsumerPosition
    from flow_sdk.builtin.source_item import MessageSpec
    from flow_sdk.core.entity.entity_model import Entity
    from flow_sdk.ingest.driver_runtime import SendOutcome

T = TypeVar("T")
logger = logging.getLogger(__name__)


def _announce_needs_review(source, row, consumer: str) -> None:
    """The review signal: a tag the Events screen renders, beside the log line."""
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    emit_tag(
        f"ingest.{source.provider}.reply.needs_review",
        target_of("data_source", str(source.id)),
        {"source_id": str(source.id), "item_id": str(row.id), "consumer": consumer},
    )


class Delivered(Generic[T]):
    __slots__ = ("item", "redelivered", "source_id", "_position", "_row", "_quoted")

    def __init__(
        self,
        item: T,
        *,
        position: "ConsumerPosition",
        row: "Entity",
        source_id: str,
        redelivered: bool = False,
        quoted: Any = None,
    ) -> None:
        self.item = item
        self.redelivered = redelivered
        self.source_id = source_id
        self._position = position
        self._row = row
        self._quoted = quoted

    def __getattr__(self, name: str) -> Any:
        # Only reached when normal lookup fails, so the envelope's own fields never recurse.
        if name.startswith("_"):
            raise AttributeError(name)
        return getattr(self.item, name)

    def __repr__(self) -> str:
        flag = " redelivered" if self.redelivered else ""
        return f"Delivered({self.item!r}{flag})"

    @property
    def acked(self) -> bool:
        return self._position.is_acked(self._row)

    async def _source(self):
        """The source this item arrived through. Raises rather than returning
        ``None``: every caller here is about to send, and "gone" is not a case
        any of them can carry on from."""
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

        source = await DataSource.get_by_id(self.source_id)
        if source is None:
            raise LookupError(f"source {self.source_id} is gone; nothing to reply through")
        return source

    # ── what the message carries ────────────────────────────────────────
    @property
    def files(self) -> tuple:
        """The files that came with this message (``MessageFileData``: ``name``, ``media_type``,
        ``as_``, ``caption``, ``path``) — already copied to this machine when it arrived; a file
        whose bytes never came says why in ``fetch_error``."""
        data = getattr(self.item, "data", None)
        return tuple(f.data for f in getattr(data, "attachments", ()) or ())

    @property
    def reply_to(self) -> Any:
        """The message this one quotes (its ``SourceItem``), or ``None`` — looked up when it was handed out."""
        return self._quoted

    @property
    def reactions(self) -> list:
        """Who reacted with what on this message, as of now (``MessageReaction``)."""
        return list(getattr(self._row, "reactions", None) or [])

    async def react(self, emoji: str) -> list:
        """Put our ``emoji`` on this message; on a channel that keeps one per person it replaces ours."""
        from flow_sdk.stream_inbox.reactions import react  # noqa: PLC0415

        self._row.reactions = await react(self._row, emoji)
        return self.reactions

    async def unreact(self, emoji: str = "") -> list:
        """Take back our ``emoji`` (all of ours with ``""``)."""
        from flow_sdk.stream_inbox.reactions import unreact  # noqa: PLC0415

        self._row.reactions = await unreact(self._row, emoji)
        return self.reactions

    async def reply_spec(self, *, body: str, files=(), quote: "bool | None" = None) -> "MessageSpec":
        """The reply to THIS item, in its own channel's shape — the rule and the
        reason are ``DataSource.reply_spec``'s. Async only because it reads the
        source.

        ``quote=None`` quotes this message only when the person wrote again before the answer
        went out — what a person does; quoting every answer in a 1:1 chat is noise."""
        source = await self._source()
        if quote is None:
            quote = await self._newer_from_them(source)
        return source.reply_spec(self.item, body=body, files=files, quote=quote)

    async def _newer_from_them(self, source) -> bool:
        """Did the person write again in this thread after this message? Only rows ingested since it
        are read — an indexed range, however long the chat."""
        from flow_sdk.builtin import ingest_order  # noqa: PLC0415
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

        thread = getattr(self._row, "thread_key", None)
        since = getattr(self._row, "created_date", None)
        if not thread or since is None:
            return False
        rows = await SourceItem.get_all(QueryFilter(match=ExpressionNode(op=QueryOp.AND, operands=[
            ExpressionNode(op=QueryOp.EQ, operands=["data_source_id", str(source.id)]),
            ExpressionNode(op=QueryOp.GT, operands=["created_date", ingest_order.bind(since)]),
            ExpressionNode(op=QueryOp.EQ, operands=["thread_key", thread]),
        ])))
        return any(str(r.id) != str(self._row.id) and not r.is_ours(source) for r in rows)

    async def reply(self, spec: "MessageSpec | str") -> "SendOutcome | None":
        """Send *spec* as the answer to this item, then ack — the piggybacked ack.

        A plain ``str`` is the common case — "answer with this text" — and is the same as
        ``await m.reply(await m.reply_spec(body=text))``: addressed the way THIS channel replies.
        Pass a ``MessageSpec`` for anything more (files, a subject, an explicit ``quote``).

        The order is what makes it safe: **intent → send → record → ack**. Intent goes on the
        position row BEFORE the send, so a crash anywhere in the window is visible on
        redelivery; and a redelivered item never sends again. It syncs the source, looks for
        our own outbound copy (``SourceItem.find_reply_from_self``), and either acks on the
        evidence or acks with ``needs_review`` and says so — because a missed reply is
        recoverable and a doubled one is not. ``SendOutcome.recorded`` already states that
        rule: *re-sending to fix the bookkeeping would mail the recipient twice*.

        A ``DRAFTED`` outcome acks: the draft is a real outcome that reached nobody.
        Returns the outcome, or ``None`` when nothing was sent on this call.
        """
        from datetime import datetime, timezone  # noqa: PLC0415

        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.ingest.driver_runtime import SendOutcome  # noqa: PLC0415
        from flow_sdk.ingest.poller import poll_source  # noqa: PLC0415

        if isinstance(spec, str):
            spec = await self.reply_spec(body=spec)
        position, row = self._position, self._row
        source = await self._source()

        if position.replying_to == str(row.id):
            if position.replied_external_id:
                # Crashed between record and ack: the send is on record, only the ack is owed.
                # Read it BEFORE acking — the ack clears the intent fields.
                sent_id = position.replied_external_id
                await self.ack()
                return SendOutcome(external_id=sent_id, recorded=False)
            # Crashed between send and record: the provider may or may not have sent.
            await poll_source(source)
            found = await SourceItem.find_reply_from_self(source, row, since=position.replying_started_at)
            if found is not None:
                position.replied_external_id = found.external_id or ""
                await position.commit()
                await self.ack()
                return SendOutcome(external_id=found.external_id or "", recorded=True)
            position.needs_review.append(str(row.id))
            logger.warning(
                "blocks: reply to %s on %s could not be proven sent or unsent; acked without sending "
                "(consumer=%r) — review it rather than risk mailing twice",
                row.id, source.name or source.id, position.consumer,
            )
            _announce_needs_review(source, row, position.consumer)
            await self.ack()
            return None

        position.replying_to = str(row.id)
        position.replying_started_at = datetime.now(timezone.utc)
        position.replied_external_id = ""
        await position.commit()                                    # intent, before the send
        outcome = await source.send(spec)
        position.replied_external_id = outcome.external_id or f"{outcome.status}:{position.replying_started_at.isoformat()}"
        await position.commit()                                    # record
        await self.ack()                                           # then, and only then, ack
        return outcome

    async def ack(self) -> None:
        """Commit the position at this item. Acking an item commits everything before it.

        Idempotent, and a no-op for an older item once a newer one is acked. Writes nothing
        when the watermark did not move, and nothing at all outside a named ``workflow()``.
        """
        if self._position.advance_to(self._row):
            await self._position.commit()


class DeliveredPage:
    """One page a listener handed you — up to ``size`` deliveries from ONE source — and the
    handle to say you are done with all of them.

    ``ack()`` commits the position at the page's last row: one write per page, because
    ``ConsumerPosition.advance_to`` is an offset. Each item inside still has its own ``ack()``
    for a consumer that wants the finer grain. A page is always one source's — a merge of
    several sources yields their pages side by side, never a page that spans two positions.
    """

    __slots__ = ("items", "source_id", "_position", "_last")

    def __init__(self, items: "list[Delivered]", *, position: "ConsumerPosition", source_id: str, last: "Entity") -> None:
        self.items = items
        self.source_id = source_id
        self._position = position
        #: The last ROW the page covers — filtered rows included, so the ack never leaves a gap.
        self._last = last

    def __iter__(self):
        return iter(self.items)

    def __len__(self) -> int:
        return len(self.items)

    def __repr__(self) -> str:
        return f"DeliveredPage({len(self.items)} items, source={self.source_id})"

    @property
    def acked(self) -> bool:
        return self._position.is_acked(self._last)

    async def ack(self) -> None:
        """Commit the position at this page's last row. Idempotent; a no-op once a newer row is acked."""
        if self._position.advance_to(self._last):
            await self._position.commit()


__all__ = ["Delivered", "DeliveredPage"]
