"""The id the index walk assigns a filesystem asset, for tests.

``reconcile`` (``flow_sdk.fs_store.indexer.reconcile``) is the one seam: the
carrier against the row that owns the path. This wraps the ``ref → layout``
step so a test can ask for an id the way the walk does.
"""
from __future__ import annotations

from collections.abc import Container
from typing import Any


def resolve_id(
    info: Any,
    ref: Any,
    *,
    owner_id: str | None = None,
    live_ids: Container[str] | None = None,
    write: bool | None = None,
) -> str:
    """``reconcile`` for ``ref`` (an ``FSRef`` or a path) under ``info``;
    writes unless the ref is read-only or ``write`` says otherwise."""
    from flow_sdk.fs_store.indexer.reconcile import reconcile

    if write is None:
        write = not bool(getattr(ref, "read_only", False))
    return reconcile(info, info.layout_for(ref), owner_id, live_ids, write=write, ref=ref)


def frontmatter_id(path: Any) -> str | None:
    """The valid ``id:`` a markdown document's frontmatter carries, else None."""
    from pathlib import Path

    from flow_sdk.fs_store.identity_carrier import Found, Frontmatter

    found = Frontmatter().read(Path(getattr(path, "_path", path)))
    return found.id if isinstance(found, Found) else None


async def index_path(type_name: str, path: Any, *, write: bool = True) -> Any:
    """Resolve ONE path as ``type_name`` and index it: the record, or None when
    the path is not that type's asset (``resolve_asset`` → ``index_one``)."""
    from flow_sdk.fs_store.resolve import NotAnAsset, index_one, resolve_asset

    try:
        resolved = await resolve_asset(path, write=write, type_name=type_name)
    except NotAnAsset:
        return None
    return await index_one(resolved)
