"""Identity by ORIGIN — the source's own handle for an asset, looked up.

``Entity.origin_id`` holds the name a source gave a file (an inode, a git key,
a Drive ``fileId``); two observations carrying the same handle converge on one
row. Resolved by lookup, never by id arithmetic, and never read out of the
bytes — which is what lets a file indexed in place and its copy in a project
be ONE entity without either carrying an identity capsule.

Not an ``IdentityBackend``: that protocol observes a PATH; this resolves a
handle across every asset-owning type. Two verbs, used by reflection.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


async def resolve(origin_id: str) -> Optional[Any]:
    """The row this origin already names, across every file-backed type.

    ``Entity.first_across_asset_owners`` is the fan-out — the same candidate set
    and the same reason as ``get_by_asset_ref``: a base-class query does not
    reach concrete-type rows, and only a type that OWNS its asset may answer who
    owns an origin. A newly registered type is searchable here the moment it is
    registered, and a fan-out that failed on a contended DB says so in the log
    instead of reading as "this origin is new".
    """
    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    if not origin_id:
        return None
    return await Entity.first_across_asset_owners("origin_id", origin_id)


async def stamp(entity: Any, origin_id: str, *, reload: bool = True) -> None:
    """Record ``origin_id`` on the row as it stands AFTER indexing.

    ``reload`` re-reads a pre-index instance rather than trusting it: the index
    pass may have rewritten the row (and the file — a capsule stamp moves an
    inode), so the stamp lands on the row that exists now. A row the caller
    just fetched after indexing passes ``reload=False``.
    """
    if entity is None:
        return
    current = entity
    if reload:
        try:
            current = await type(entity).get_by_id(str(entity.id))
        except Exception:  # noqa: BLE001
            current = entity
    if current is not None and current.origin_id != origin_id:
        current.origin_id = origin_id
        await current.save()
