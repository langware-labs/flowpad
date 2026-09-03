"""``Delivered`` — one item a listener handed you, and the handle to say you are done with it.

Not a value. The item inside is the frozen ``SourceItemSpec`` (or a ``FolderChange``) and stays
one; this is the envelope around it — the ``MessageRequest`` role, except that it holds a
position and a source, which are not values. Attribute reads fall through to the item, so
``EmailMessageSpec.reply_to(m, …)`` and ``agent.process_message(m)`` take the envelope
unchanged. Reach for ``.item`` when you want the value itself.

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
    from flow_sdk.ingest.driver import SendOutcome

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
    __slots__ = ("item", "redelivered", "source_id", "_position", "_row")

    def __init__(
        self,
        item: T,
        *,
        position: "ConsumerPosition",
        row: "Entity",
        source_id: str,
        redelivered: bool = False,
    ) -> None:
        self.item = item
        self.redelivered = redelivered
        self.source_id = source_id
        self._position = position
        self._row = row

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

    async def reply(self, spec: "MessageSpec") -> "SendOutcome | None":
        """Send *spec* as the answer to this item, then ack — the piggybacked ack.

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

        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
        from flow_sdk.builtin.source_item import SourceItem  # noqa: PLC0415
        from flow_sdk.ingest.driver import SendOutcome  # noqa: PLC0415
        from flow_sdk.ingest.poller import poll_source  # noqa: PLC0415

        position, row = self._position, self._row
        source = await DataSource.get_by_id(self.source_id)
        if source is None:
            raise LookupError(f"source {self.source_id} is gone; nothing to reply through")

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


__all__ = ["Delivered"]
