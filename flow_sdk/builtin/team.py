import logging
# Created by tzahimazuz at 15:56 15/10/2024
from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity, action
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.responses import ApiSuccessResponse


class Team(Entity):
    type: str = APIField(default=BuiltinEntityType.TEAM.value)
    name: str = APIField()
    _api_visible: ClassVar[bool] = True
    _generate_key = True

    @action.all()
    def children(self):
        return ApiSuccessResponse(data="Children of team: " + self.name)
