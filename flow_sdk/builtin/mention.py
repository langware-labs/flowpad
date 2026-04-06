import logging
from __future__ import annotations

from typing import ClassVar, List, Optional, Union

from fastapi import HTTPException

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.user import User
from flow_sdk.core import Entity, QueryFilter
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Mention(Entity):
    type: str = APIField(default=BuiltinEntityType.MENTION.value)
    mentioned_by_id: Optional[str] = APIField(None)
    mentioned_user_id: Optional[str] = APIField(None)
    mentioned_in_entity_type: Optional[str] = APIField(None)
    mentioned_in_entity_id: Optional[str] = APIField(None)
    target_url_path: Optional[str] = APIField(None)
    sent: Optional[bool] = APIField(False)
    _api_visible: ClassVar[bool] = True

    @classmethod
    async def get_mention_for_sending_email(
        cls: type[Mention],
        typeid: TypeId,
    ) -> List[Mention]:
        _filter = QueryFilter.parse(
            {
                "mentioned_in_entity_type": typeid.type,
                "mentioned_in_entity_id": typeid.id,
                "sent": False,
            },
            BuiltinEntityType.MENTION.value,
        )
        return await cls.get_all(entities_filter=_filter)

    async def save(self, owner: Union[Entity, TypeId, None] = None, notify: bool = True) -> Mention:
        mentioned_in = await Entity.get_by_typeid(
            TypeId(type=self.mentioned_in_entity_type, id=self.mentioned_in_entity_id)
        )
        if not mentioned_in:
            raise HTTPException(status_code=400, detail="Entity not found, can not save mention")
        if not self.mentioned_user_id:
            raise HTTPException(status_code=400, detail="User not found, can not save mention")
        _mentioned_user = await User.get_by_id(self.mentioned_user_id)
        if not _mentioned_user:
            raise HTTPException(status_code=400, detail=f"User {self.id} not found")
        roles, _ = await _mentioned_user.get_roles(mentioned_in)
        if len(roles) == 0:
            raise HTTPException(
                status_code=400,
                detail=f"{self.mentioned_user_id} is not a member in {self.mentioned_in_entity_type}",
            )
        return await super().save(owner, notify=notify)
