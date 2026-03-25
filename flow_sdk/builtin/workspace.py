import logging
import types
from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.core import Entity
from flow_sdk.db.db_entity import DBEntity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import EntityType
from flow_sdk.request_context.methods import get_current_request_info


class Workspace(Entity):
    type: str = APIField(default=BuiltinEntityType.WORKSPACE.value)
    name: str = APIField()
    _api_visible: ClassVar[bool] = True

    async def save(self: EntityType, owner: DBEntity | TypeId | types.NoneType = None) -> EntityType:
        save_result = await super().save(owner)
        # TODO consider moving this to a separate action from client side
        await self.grant_access_to_public_data()
        return save_result

    @classmethod
    async def get_workspace_from_target_entity(cls):
        request_info = get_current_request_info()
        if not request_info:
            raise Exception("Invalid request_info.")
        target_entity_typeid = request_info.target_entity_typeid
        if not target_entity_typeid:
            raise Exception("Invalid target_entity - expected a workspace.", target_entity_typeid)
        if target_entity_typeid.type != cls.get_type() or not target_entity_typeid.id:
            raise Exception("Invalid target_entity - expected a workspace.", target_entity_typeid)
        workspace = await request_info.get_target_entity()
        if not workspace:
            raise Exception("Invalid target_entity - workspace doesn't exist.", target_entity_typeid.id)
        return workspace
