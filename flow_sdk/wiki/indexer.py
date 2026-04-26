"""Public type/id-only API for the wiki layer.

`outgoing`, `backlinks`, and `index` are the only entry points used outside
the wiki package. Internally they delegate to a default LinkStore + the
parser/resolver. Both `Record.get_links()` / `Entity.get_links()` and the
`sync_to_db` hook call into these functions.

The store, parser, and resolver are wired together at first call time
against the shared default DB driver so test fixtures (initialize_test_db)
that swap drivers transparently work.
"""

from .types import WikiLink


def _store():
    """Lazy import to avoid circular deps at module load."""
    from .store import get_default_store

    return get_default_store()


def outgoing(type: str, id: str) -> list[WikiLink]:
    """Edges going out of the source record."""
    return _store().outgoing_from(type, id)


def backlinks(type: str, id: str) -> list[WikiLink]:
    """Edges pointing at the target record."""
    return _store().backlinks_of(type, id)


def index(type: str, id: str, body: str | None) -> None:
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
        resolve_link(link, src_type=type, src_id=id) for link in parsed
    ]
    _store().replace_for_source(type, id, resolved)


def delete_for_id(type: str, id: str) -> None:
    """Drop every edge mentioning ``(type, id)`` on either side.

    Called from ``Entity.delete()`` / ``Entity.delete_by_id()`` so the wiki
    edge table is kept consistent when records go away. See
    :meth:`flow_sdk.wiki.store.LinkStore.delete_for_id` for the contract.
    """
    _store().delete_for_id(type, id)
