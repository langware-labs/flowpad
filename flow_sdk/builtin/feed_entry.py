"""Home-landing Feed entities.

``FeedEntry`` owns feed lifecycle only. Its ``data`` points at the entity that
should render inside the feed; entry-specific meaning lives on that entity.
"""
from __future__ import annotations

import logging
from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.core import Entity
from flow_sdk.db.drivers.query import QueryFilter

logger = logging.getLogger(__name__)


class FeedStatus(StrEnum):
    NEW = "new"
    DISMISSED = "dismissed"
    EXPIRED = "expired"


class FeedEntry(Entity):
    type: str = APIField(default="feed_entry")
    # Visibility lifecycle — only ``new`` renders in the Feed.
    feed_status: str = APIField(default=FeedStatus.NEW.value)
    # Feed-management data. For normal entries this is {"type_id": "<type>-<id>"}.
    data: Optional[dict] = APIField(default=None)

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "Bell"

    @staticmethod
    def _target_type_id(entry: "FeedEntry") -> TypeId | None:
        if not isinstance(entry.data, dict):
            return None
        raw = entry.data.get("type_id")
        if not isinstance(raw, str):
            return None
        try:
            return TypeId(raw)
        except (IndexError, ValueError):
            return None

    @classmethod
    async def _existing_targets(cls, targets: "list[TypeId]") -> "set[tuple[str, str]]":
        """Which of *targets* still resolve, as ``(type, id)`` pairs.

        ONE ``id IN (…)`` query per entity type, rather than a ``get_by_id``
        per entry: the caller runs on the feed read path, so a per-row probe
        made every Home load cost a query per card.

        Fails OPEN — an unknown type, or a query that raises, counts its ids as
        existing. Expiry is persisted and irreversible from here, so a
        transient DB hiccup must never mass-expire a live feed. The cost of
        failing open is one more dead ``GET`` next load; the cost of failing
        closed is a silently emptied feed.
        """
        from flow_sdk.db.drivers.query import ExpressionNode, QueryOp  # noqa: PLC0415

        ids_by_type: dict[str, set[str]] = {}
        for tid in targets:
            ids_by_type.setdefault(tid.type, set()).add(str(tid.id))

        existing: set[tuple[str, str]] = set()
        for type_name, ids in ids_by_type.items():
            target_cls = Entity.get_entity_model_by_type(type_name)
            if target_cls is None:
                existing.update((type_name, i) for i in ids)
                continue
            try:
                rows = await target_cls.get_all(
                    entities_filter=QueryFilter(match=ExpressionNode(op=QueryOp.IN, operands=["id", sorted(ids)]))
                )
            except Exception:
                logger.warning("[feed-prune] existence query failed for type %s; failing open", type_name)
                existing.update((type_name, i) for i in ids)
                continue
            existing.update((type_name, str(row.id)) for row in rows)
        return existing

    @classmethod
    async def get_all(
        cls,
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> list["FeedEntry"]:
        entries = await super().get_all(entities_filter=entities_filter, source_entity=source_entity)

        # Resolve every candidate target in one pass BEFORE touching any entry,
        # so the read path costs one query per target type instead of one per
        # card. Entries whose status is not NEW, or that carry no parsable
        # ref, are not candidates and are left alone exactly as before.
        candidates: dict[str, TypeId] = {}
        for entry in entries:
            if entry.feed_status != FeedStatus.NEW.value:
                continue
            if not isinstance(entry.data, dict) or "type_id" not in entry.data:
                continue
            target = cls._target_type_id(entry)
            if target is None or target.id is None:
                # Unparsable or id-less ref: it can never resolve, so it expires
                # — the same answer the per-row probe gave.
                entry.feed_status = FeedStatus.EXPIRED.value
                await entry.save(notify=True)
                continue
            candidates[entry.id] = target

        if not candidates:
            return entries

        existing = await cls._existing_targets(list(candidates.values()))
        for entry in entries:
            target = candidates.get(entry.id)
            if target is None:
                continue
            if (target.type, str(target.id)) in existing:
                continue
            entry.feed_status = FeedStatus.EXPIRED.value
            await entry.save(notify=True)

        # Expired entries are still RETURNED, as they always were: the caller
        # renders them as unavailable rather than having rows vanish mid-scroll.
        # Only the cost of deciding that changed here.
        return entries
