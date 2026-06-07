"""AsyncLinkStore — async CRUD on the `links` table.

Uses the same async SQLAlchemy engine as the rest of the system via
`flow_sdk.db.session()`. Inside an HTTP request the wiki writes share the
request transaction, so `Entity.delete()` + `wiki.delete_for_id()` either
both commit or both roll back — atomic.
"""

from __future__ import annotations

from typing import Iterable

from sqlalchemy import delete as sa_delete, insert as sa_insert, select as sa_select

from flow_sdk.db.drivers.sqlite.connection import LinksSchema

from .types import WikiLink


def _orm_row_to_link(row: LinksSchema) -> WikiLink:
    return WikiLink(
        id=row.id,
        src_type=row.src_type,
        src_id=row.src_id,
        raw=row.target_raw,
        target_type=row.target_resolved_type,
        target_id=row.target_resolved_id,
        line=row.line,
    )


class AsyncLinkStore:
    """Async CRUD on the `links` table over the shared SQLAlchemy engine.

    Stateless — every method opens a session via `flow_sdk.db.session()`,
    which yields the request session inside a request and a fresh
    auto-committing session outside one. Wiki writes inside a request
    share the request transaction with everything else the request did.
    """

    # ---------------- writes ----------------

    async def delete_for_id(self, type: str, id: str) -> None:
        """Drop every edge in `links` mentioning `(type, id)` on either side."""
        from flow_sdk.db import session as _session  # noqa: PLC0415
        async with _session() as s:
            await s.execute(
                sa_delete(LinksSchema).where(
                    LinksSchema.src_type == type,
                    LinksSchema.src_id == id,
                )
            )
            await s.execute(
                sa_delete(LinksSchema).where(
                    LinksSchema.target_resolved_type == type,
                    LinksSchema.target_resolved_id == id,
                )
            )

    async def replace_for_source(
        self, src_type: str, src_id: str, links: Iterable[WikiLink]
    ) -> None:
        """Atomic DELETE + INSERT for one source. Idempotent."""
        from flow_sdk.db import session as _session  # noqa: PLC0415
        rows = [
            {
                "src_type": src_type,
                "src_id": src_id,
                "target_raw": link.raw,
                "target_resolved_type": link.target_type,
                "target_resolved_id": link.target_id,
                "line": link.line,
            }
            for link in links
        ]
        async with _session() as s:
            await s.execute(
                sa_delete(LinksSchema).where(
                    LinksSchema.src_type == src_type,
                    LinksSchema.src_id == src_id,
                )
            )
            if rows:
                await s.execute(sa_insert(LinksSchema), rows)

    # ---------------- reads ----------------

    async def outgoing_from(self, src_type: str, src_id: str) -> list[WikiLink]:
        from flow_sdk.db import session as _session  # noqa: PLC0415
        async with _session(write=False) as s:
            result = await s.execute(
                sa_select(LinksSchema)
                .where(LinksSchema.src_type == src_type, LinksSchema.src_id == src_id)
                .order_by(LinksSchema.line, LinksSchema.id)
            )
            return [_orm_row_to_link(r) for r in result.scalars().all()]

    async def backlinks_of(self, target_type: str, target_id: str) -> list[WikiLink]:
        from flow_sdk.db import session as _session  # noqa: PLC0415
        async with _session(write=False) as s:
            result = await s.execute(
                sa_select(LinksSchema)
                .where(
                    LinksSchema.target_resolved_type == target_type,
                    LinksSchema.target_resolved_id == target_id,
                )
                .order_by(
                    LinksSchema.src_type,
                    LinksSchema.src_id,
                    LinksSchema.line,
                    LinksSchema.id,
                )
            )
            return [_orm_row_to_link(r) for r in result.scalars().all()]

    async def find_unresolved(self, target_raw: str) -> list[WikiLink]:
        from flow_sdk.db import session as _session  # noqa: PLC0415
        async with _session(write=False) as s:
            result = await s.execute(
                sa_select(LinksSchema).where(
                    LinksSchema.target_resolved_id.is_(None),
                    LinksSchema.target_raw == target_raw,
                )
            )
            return [_orm_row_to_link(r) for r in result.scalars().all()]

    # Read entities by uname / data.name — used by the resolver.
    async def find_entities_by_uname_or_name(
        self, name: str
    ) -> list[tuple[str, str]]:
        """Return [(type, id), ...] of entities whose name matches.

        Tries the indexed `uname` column first, then falls back to JSON
        `data.name`. Mirrors the legacy resolver behavior.
        """
        from flow_sdk.db import session as _session  # noqa: PLC0415
        from flow_sdk.db.drivers.sqlite.connection import EntitySchema  # noqa: PLC0415
        from sqlalchemy import text  # noqa: PLC0415

        async with _session(write=False) as s:
            result = await s.execute(
                sa_select(EntitySchema.type, EntitySchema.id).where(EntitySchema.uname == name)
            )
            rows = result.all()
            if rows:
                return [(r[0], r[1]) for r in rows]
            result = await s.execute(
                sa_select(EntitySchema.type, EntitySchema.id).where(
                    text("json_extract(data, '$.name') = :name").bindparams(name=name)
                )
            )
            return [(r[0], r[1]) for r in result.all()]


_async_default_store: "AsyncLinkStore | None" = None


def get_async_default_store() -> "AsyncLinkStore":
    global _async_default_store
    if _async_default_store is None:
        _async_default_store = AsyncLinkStore()
    return _async_default_store
