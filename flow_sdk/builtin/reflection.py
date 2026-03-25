import logging
from datetime import datetime
from typing import Any, ClassVar, Dict, List, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, QueryFilter


class Reflection(Entity):
    type: str = APIField(default="reflection")
    reflection_key: str = APIField()
    reflection_type: str = APIField()
    sync_token: Optional[str] = APIField(None)  # Placeholder for the sync token
    sync_delta: Optional[Dict[str, Any]] = APIField(None)  # Placeholder for the sync deltas
    synced_date: Optional[datetime] = APIField(None)
    _unique: ClassVar[List[str]] = ["reflection_key"]

    async def get_native(self) -> Optional[Entity]:
        # Consider returning a list
        rels = await self.get_incoming_relationships()
        if rels and rels[0].from_typeid:
            return await Entity.get_by_typeid(rels[0].from_typeid)
        return None

    @staticmethod
    async def get_reflection(entity: Entity, reflection_type: str) -> Optional["Reflection"]:
        # Consider returning a list
        to_filter = QueryFilter.parse({"reflection_type": reflection_type})
        to_filter.type = Reflection.get_type()
        rels = await entity.get_outgoing_relationships(to_filter=to_filter)
        if rels and rels[0].to_typeid and rels[0].to_typeid.id:
            return await Reflection.get_by_id(rels[0].to_typeid.id)
        return None

    @staticmethod
    async def get_reflection_by_key(reflection_key: str) -> Optional["Reflection"]:
        return await Reflection.get_one({"reflection_key": reflection_key})

    @staticmethod
    async def get_native_by_key(reflection_key: str) -> Optional[Entity]:
        reflection = await Reflection.get_reflection_by_key(reflection_key)
        if reflection:
            return await reflection.get_native()
        return None
