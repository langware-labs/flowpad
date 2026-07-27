"""Home-landing Feed entities.

``FeedEntry`` owns feed lifecycle only. Its ``data`` points at the entity that
should render inside the feed; entry-specific meaning lives on that entity.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.core import Entity
from flow_sdk.db.drivers.query import QueryFilter


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
    async def _target_exists(cls, target_typeid: TypeId | None) -> bool:
        if target_typeid is None or target_typeid.id is None:
            return False
        target_cls = Entity.get_entity_model_by_type(target_typeid.type)
        if target_cls is None:
            return False
        target = await target_cls.get_by_id(target_typeid.id)
        return target is not None

    @classmethod
    async def get_all(
        cls,
        entities_filter: QueryFilter | dict | None = None,
        source_entity: TypeId | None = None,
    ) -> list["FeedEntry"]:
        entries = await super().get_all(entities_filter=entities_filter, source_entity=source_entity)

        for entry in entries:
            if entry.feed_status != FeedStatus.NEW.value:
                continue
            if not isinstance(entry.data, dict) or "type_id" not in entry.data:
                continue
            if await cls._target_exists(cls._target_type_id(entry)):
                continue
            entry.feed_status = FeedStatus.EXPIRED.value
            await entry.save(notify=True)

        return entries
