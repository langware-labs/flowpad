"""SourceChange — one reflected page of an object-shaped source, as a row a consumer can page.

A folder source produces no ``SourceItem`` (by design: its bytes are already on disk and
reading them into a record only to write them back is waste) and its change set lived only in
the transient ``FetchResult`` — which means a listener with a durable position had nothing to
page. This row is that log: ``reflect_refs``, the one place that knows each change's FINAL local
path, writes one per page it applied.

**One row per page, not per path.** ``Folder.listen()`` yields one change set per poll anyway;
N rows per page would be N writes to be regrouped, and a consumer could see a half-page.

**Intent survives.** ``added / changed / removed / renamed`` carry what the source observed. The
signed weight a derived index wants is computed there, not here — a rename collapsed into
retract+insert at the source loses the fact that it was a rename.

Paths are canonical absolute local paths: the coordinate a search index stores as ``doc_ref``.
Rows age out on the heartbeat (``prune_before``); a consumer further behind than that walks the
tree, which remains the authority.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin import ingest_order
from flow_sdk.core import Entity
from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp
from flow_sdk.schema.types import EntityType

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.ingest.reflect import ReflectReport


class SourceChange(Entity):
    type: str = APIField(default=EntityType.SOURCE_CHANGE.value)

    data_source_id: str = APIField(default="")
    provider: str = APIField(default="")
    added: list[str] = APIField(default_factory=list)
    changed: list[str] = APIField(default_factory=list)
    removed: list[str] = APIField(default_factory=list)
    #: ``{new_path: old_path}`` — only when the source could OBSERVE the move.
    renamed: dict[str, str] = APIField(default_factory=dict)
    #: ``{path: origin_id}`` as reflect stamped it — the handle identity travels on.
    origin_ids: dict[str, str] = APIField(default_factory=dict)

    _api_visible: ClassVar[bool] = True

    @property
    def empty(self) -> bool:
        return not (self.added or self.changed or self.removed or self.renamed)

    @classmethod
    async def record(cls, source, report: "ReflectReport") -> Optional["SourceChange"]:
        """Write one row for what *report* did. ``None`` when it did nothing."""
        row = cls(
            data_source_id=str(source.id),
            provider=str(source.provider or ""),
            added=list(report.added),
            changed=list(report.changed),
            removed=list(report.removed),
            renamed=dict(report.renamed),
            origin_ids=dict(report.origin_ids),
        )
        if row.empty:
            return None
        await row.save(notify=False)
        return row

    # ── paging, in ingest order ─────────────────────────────────────────────

    @classmethod
    async def newest_for(cls, data_source_id: str) -> Optional["SourceChange"]:
        return await ingest_order.newest_for(cls, data_source_id)

    @classmethod
    async def page_after(
        cls, data_source_id: str, after: Optional[tuple[datetime, str]], *, limit: int
    ) -> list["SourceChange"]:
        return await ingest_order.page_after(cls, data_source_id, after, limit=limit)

    # ── lifecycle ───────────────────────────────────────────────────────────

    @classmethod
    async def prune_before(cls, cutoff: datetime, *, limit: int = 200) -> int:
        """Drop rows older than *cutoff*, at most *limit* per call — bounded for the heartbeat."""
        doomed = await cls.get_all(QueryFilter(
            match=ExpressionNode(op=QueryOp.LT, operands=["created_date", ingest_order.bind(cutoff)]),
            order_by=[{"created_date": "asc"}],
            limit=max(1, int(limit)),
        ))
        for row in doomed:
            await row.destroy()
        return len(doomed)

    @classmethod
    async def delete_for(cls, data_source_id: str) -> None:
        for row in await cls.get_all({"data_source_id": data_source_id}):
            await row.destroy()


__all__ = ["SourceChange"]
