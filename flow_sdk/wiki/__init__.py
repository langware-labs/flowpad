"""Wiki link layer — the type/id-only public API.

Agnostic to whether `Record` or `Entity` calls it; internally everything
delegates to the shared `AsyncLinkStore` (over the SQLAlchemy engine) plus the
parser/resolver.

  - outgoing(type, id)         → list[WikiLink] going out of a source
  - backlinks(type, id)        → list[WikiLink] coming in to a target
  - index(type, id, body)      → re-extract & replace edges for one source
                                 (called by Record.sync_to_db)
  - delete_for_id(type, id)    → drop every edge mentioning this entity on
                                 either side; called by Entity.delete /
                                 Entity.delete_by_id.

All four are coroutines. Wiki writes inside an HTTP request share the request
transaction with the rest of the request's work — so e.g. `Entity.delete()` +
`wiki.delete_for_id()` either both commit or both roll back.
"""

from .types import WikiLink

def _store():
    """Lazy import to avoid circular deps at module load."""
    from .store import get_async_default_store

    return get_async_default_store()


async def outgoing(type: str, id: str) -> list[WikiLink]:
    """Edges going out of the source record."""
    return await _store().outgoing_from(type, id)


async def backlinks(type: str, id: str) -> list[WikiLink]:
    """Edges pointing at the target record."""
    return await _store().backlinks_of(type, id)


async def index(type: str, id: str, body: str | None) -> None:
    """Re-extract links from `body` and replace this source's edges.

    `body is None` (record is not a wiki source) → no-op.
    Empty body → all existing rows for this source are deleted, no new rows.
    """
    if body is None:
        return

    from .parser import parse_links
    from .resolver import resolve_link

    parsed = parse_links(body)
    resolved = [
        await resolve_link(link, src_type=type, src_id=id) for link in parsed
    ]
    await _store().replace_for_source(type, id, resolved)


async def delete_for_id(type: str, id: str) -> None:
    """Drop every edge mentioning ``(type, id)`` on either side.

    Called from ``Entity.delete()`` / ``Entity.delete_by_id()`` so the wiki
    edge table is kept consistent when records go away. Inside an HTTP
    request, the delete shares the request transaction.
    """
    await _store().delete_for_id(type, id)


__all__ = ["WikiLink", "outgoing", "backlinks", "index", "delete_for_id"]
