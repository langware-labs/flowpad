import logging
# Created by tzahimazuz at 22:28 07/10/2023
from typing import Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Organization(Entity):
    type: str = APIField(default=BuiltinEntityType.ORGANIZATION.value)
    name: str = APIField()
    account: Optional[str] = APIField(None)
    domain: Optional[str] = APIField(None)
    icon: Optional[str] = APIField(None)
