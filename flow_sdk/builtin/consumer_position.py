"""ConsumerPosition — how far ONE consumer has got through ONE source.

The second cursor. ``DataSourceCursor`` answers "what has the source told us" and is owned
by ``sync``; this row answers "what has *this workflow* dealt with" and is owned by ``ack()``.
Same source, N workflows, N positions, one ingest. Collapsing them is how a consumer's crash
would rewind the source, or a poll would mark a consumer's work done.

**Per row, never a dict on the DataSource** — the rule ``DataSourceCursor`` states, for the
same reason: concurrent advances of one row lose each other.

**The position is an offset, not a set.** ``advance_to(item)`` commits everything at or
before that item's ``(created_date, id)``. That is the Kafka grain, settled deliberately:
per-item bookkeeping does not survive fan-out, and an implementation that coalesces a run of
acks into one write needs a watermark to coalesce onto. Paging is on ``created_date`` — a
real column, monotonic with insertion — because ingest order is what a position means;
``occurred_at`` lives in the JSON blob, is unindexed, and sorting on it disables SQL
pagination.

**Intent lives here too.** ``in_flight_*`` is what a restart redelivers; ``replying_*`` is the
outbox for one reply, written BEFORE the send so a crash in the window is visible and a
redelivery can refuse to mail twice.

**No name, no identity.** ``consumer == ""`` is an unsaved row: ``commit()`` writes nothing
and the position lives for the loop. ``workflow("x")`` is what buys durability.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import TYPE_CHECKING, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.core.entity.entity_model import Entity as _AnyEntity

#: A position key: the row's ingest order, total because ``id`` is unique.
PositionKey = tuple[datetime, str]


def _utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def key_of(entity: "_AnyEntity") -> PositionKey:
    """The ``(created_date, id)`` of a row — what every comparison here is over."""
    created = _utc(getattr(entity, "created_date", None))
    if created is None:
        raise ValueError(f"{entity!r} has no created_date; only a saved row has a position")
    return created, str(entity.id)


class ConsumerPosition(Entity):
    type: str = APIField(default=EntityType.CONSUMER_POSITION.value)

    #: The workflow name. Empty means ephemeral — see the module docstring.
    consumer: str = APIField(default="")
    data_source_id: str = APIField(default="")

    # ── the watermark: everything at/before this key is acked ──
    acked_created_date: Optional[datetime] = APIField(default=None)
    acked_item_id: str = APIField(default="")

    # ── last yielded, not yet acked: what a restart redelivers ──
    in_flight_created_date: Optional[datetime] = APIField(default=None)
    in_flight_item_id: str = APIField(default="")

    # ── reply intent (the outbox), one at a time ──
    replying_to: str = APIField(default="")
    replying_started_at: Optional[datetime] = APIField(default=None)
    replied_external_id: str = APIField(default="")

    # ── operator-facing ──
    #: Items acked WITHOUT a send because a redelivery could not prove the first send
    #: never happened. A missed reply is recoverable; a doubled one is not.
    needs_review: list[str] = APIField(default_factory=list)
    acked_count: int = APIField(default=0)
    last_acked_at: Optional[datetime] = APIField(default=None)

    _api_visible: ClassVar[bool] = True

    # ── identity ────────────────────────────────────────────────────────────

    @property
    def durable(self) -> bool:
        return bool(self.consumer)

    @classmethod
    async def ensure_for(
        cls,
        consumer: str,
        data_source_id: str,
        *,
        baseline: Optional["_AnyEntity"] = None,
    ) -> "ConsumerPosition":
        """Get-or-create by ``(consumer, data_source_id)`` — a lookup, never a derived id.

        On CREATE the watermark starts at *baseline* (the newest existing row), so a fresh
        listener yields arrivals, not history — today's ``Inbox.listen`` semantics. Pass
        ``None`` to start from the beginning; a folder consumer does, because a search index
        has to see the tree once.

        An empty *consumer* answers an unsaved row: the ephemeral position.
        """
        consumer = (consumer or "").strip()
        if consumer:
            existing = await cls.get_one({"consumer": consumer, "data_source_id": data_source_id})
            if existing is not None:
                return existing
        row = cls(consumer=consumer, data_source_id=data_source_id)
        if baseline is not None:
            row.acked_created_date, row.acked_item_id = key_of(baseline)
        if consumer:
            await row.save(notify=False)
        return row

    async def commit(self) -> None:
        """The one write seam. Nothing for an ephemeral row."""
        if self.durable:
            await self.save(notify=False)

    # ── the keys ────────────────────────────────────────────────────────────

    def watermark(self) -> Optional[PositionKey]:
        """The acked key. Not ``key`` — that name is the entity's own column."""
        if self.acked_created_date is None:
            return None
        return _utc(self.acked_created_date), self.acked_item_id

    def in_flight_key(self) -> Optional[PositionKey]:
        if self.in_flight_created_date is None:
            return None
        return _utc(self.in_flight_created_date), self.in_flight_item_id

    def is_acked(self, entity: "_AnyEntity") -> bool:
        acked = self.watermark()
        return acked is not None and key_of(entity) <= acked

    # ── movement: forward only ──────────────────────────────────────────────

    def mark_in_flight(self, entity: "_AnyEntity") -> bool:
        """Record that *entity* was handed to the consumer. Returns whether it moved."""
        k = key_of(entity)
        current = self.in_flight_key()
        if current is not None and k <= current:
            return False
        self.in_flight_created_date, self.in_flight_item_id = k
        return True

    def advance_to(self, entity: "_AnyEntity") -> bool:
        """Ack: commit everything at or before *entity*. Returns whether the watermark moved.

        Never regresses — acking an older item after a newer one is a no-op, which is what
        lets a consumer that fans out ack in any order. Clears an in-flight mark and a reply
        intent that this ack covers.
        """
        k = key_of(entity)
        if self.is_acked(entity):
            return False
        self.acked_created_date, self.acked_item_id = k
        self.acked_count += 1
        self.last_acked_at = datetime.now(timezone.utc)
        in_flight = self.in_flight_key()
        if in_flight is not None and in_flight <= k:
            self.in_flight_created_date, self.in_flight_item_id = None, ""
        if self.replying_to == str(entity.id):
            self.replying_to, self.replying_started_at, self.replied_external_id = "", None, ""
        return True

    # ── lifecycle ───────────────────────────────────────────────────────────

    @classmethod
    async def reset_for(cls, consumer: str) -> int:
        """Forget where *consumer* got to on every source: replay history. Returns how many."""
        rows = await cls.get_all({"consumer": consumer})
        for row in rows:
            row.acked_created_date, row.acked_item_id = None, ""
            row.in_flight_created_date, row.in_flight_item_id = None, ""
            row.replying_to, row.replying_started_at, row.replied_external_id = "", None, ""
            await row.save(notify=False)
        return len(rows)

    @classmethod
    async def delete_for(cls, data_source_id: str) -> None:
        for row in await cls.get_all({"data_source_id": data_source_id}):
            await row.destroy()


__all__ = ["ConsumerPosition", "PositionKey", "key_of"]
