"""Paging a source's rows in the order they were ingested.

One implementation for every type a consumer position drains — ``SourceItem`` and
``SourceChange`` today. The order is ``(created_date, id)``: both real columns, so ORDER BY
and LIMIT push to SQL and a page is bounded; ``id`` (uuid4, total) breaks ties.

Two queries, not one: with ``>=`` and a LIMIT, a page can consist entirely of rows that share
the watermark's timestamp yet sort before its id, and skipping them leaves an empty page while
rows remain. Ties first (same timestamp, greater id), then the rest — each bounded, together
exact.

Order within one source is monotonic because every poll of a source runs through one slot and
``ingest_items`` writes sequentially; a parallel writer for one source would break this and
must not be introduced silently.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, TypeVar

from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp

T = TypeVar("T")

#: A position key: the row's ingest order.
PositionKey = tuple[datetime, str]


def bind(stamp: datetime) -> datetime:
    """A ``created_date`` as the column stores it: UTC, naive.

    Rows are written naive-UTC by the create hook; a tz-aware bind compares as a different
    string in SQLite and never matches its own row.
    """
    if stamp.tzinfo is not None:
        stamp = stamp.astimezone(timezone.utc).replace(tzinfo=None)
    return stamp


async def newest_for(cls: type[T], data_source_id: str) -> Optional[T]:
    """The last row ingested for a source — a fresh listener's baseline."""
    rows = await cls.get_all(QueryFilter(
        match=ExpressionNode(op=QueryOp.EQ, operands=["data_source_id", data_source_id]),
        order_by=[{"created_date": "desc"}, {"id": "desc"}],
        limit=1,
    ))
    return rows[0] if rows else None


async def page_after(cls: type[T], data_source_id: str, after: Optional[PositionKey], *, limit: int) -> list[T]:
    """The next *limit* rows of a source in ingest order, strictly after *after*."""
    limit = max(1, int(limit))
    source_is = ExpressionNode(op=QueryOp.EQ, operands=["data_source_id", data_source_id])
    ordered = [{"created_date": "asc"}, {"id": "asc"}]
    if after is None:
        return await cls.get_all(QueryFilter(match=source_is, order_by=ordered, limit=limit))

    stamp, last_id = after
    ties = await cls.get_all(QueryFilter(
        match=ExpressionNode(op=QueryOp.AND, operands=[
            source_is,
            ExpressionNode(op=QueryOp.EQ, operands=["created_date", bind(stamp)]),
            ExpressionNode(op=QueryOp.GT, operands=["id", last_id]),
        ]),
        order_by=[{"id": "asc"}],
        limit=limit,
    ))
    remaining = limit - len(ties)
    if remaining <= 0:
        return ties
    rest = await cls.get_all(QueryFilter(
        match=ExpressionNode(op=QueryOp.AND, operands=[
            source_is,
            ExpressionNode(op=QueryOp.GT, operands=["created_date", bind(stamp)]),
        ]),
        order_by=ordered,
        limit=remaining,
    ))
    return ties + rest


__all__ = ["PositionKey", "bind", "newest_for", "page_after"]
