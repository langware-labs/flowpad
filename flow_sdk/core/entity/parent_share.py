"""parent_share_on_default expansion for shared-context typeid lists.

The TypeInfo flag (``schema/type_info``) marks types whose parent should
ride along whenever the entity itself is shared. ``Entity.share()`` applies
the expansion for direct shares; this helper applies it where shares are
expressed as typeid lists (the conversation add-message path). One rule,
both wire-assembly seams.
"""

from __future__ import annotations

import logging

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.type_id import TypeId

logger = logging.getLogger(__name__)


def parent_share_typeid(ent) -> TypeId | None:
    """The single kernel: the parent typeid an entity should advertise on the
    share rail, or None (type not flagged / no parent / unparseable)."""
    if ent is None:
        return None
    info = SchemaRegistry.get(ent.get_type())
    if info is None or not getattr(info, "parent_share_on_default", False):
        return None
    pid = getattr(ent, "parent_type_id", None)
    if not pid:
        return None
    try:
        return TypeId(str(pid))
    except (ValueError, TypeError):
        return None


async def collect_parent_share_typeids(typeids: list[TypeId]) -> list[TypeId]:
    """Parents to share alongside ``typeids``: for each typeid whose TypeInfo
    sets ``parent_share_on_default``, the referenced entity's
    ``parent_type_id``. Deduped, order-preserving, ids already present in the
    input excluded. Best-effort per entry — a missing row never fails the send
    (the receive side re-mints deterministic parents from plain fields anyway).
    """
    present = {str(t) for t in typeids}
    out: list[TypeId] = []
    for tid in typeids:
        info = SchemaRegistry.get(tid.type)
        if info is None or not getattr(info, "parent_share_on_default", False):
            continue
        try:
            from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415
            ent = await Entity.get_by_typeid(tid)
        except Exception:  # noqa: BLE001 — best-effort expansion
            logger.warning("[parent_share] failed to load %s for expansion", tid, exc_info=True)
            continue
        parent_tid = parent_share_typeid(ent)
        if parent_tid is None or str(parent_tid) in present:
            continue
        present.add(str(parent_tid))
        out.append(parent_tid)
    return out
