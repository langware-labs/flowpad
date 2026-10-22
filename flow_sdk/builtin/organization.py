# Created by tzahimazuz at 22:28 07/10/2023
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Organization(Entity):
    #: An organization lives on the hub; the local row is only its mirror. Deleting it locally
    #: alone left the hub row in place and the next listing brought it back.
    owns_hub_delete: ClassVar[bool] = True

    type: str = APIField(default=BuiltinEntityType.ORGANIZATION.value)
    name: str = APIField()
    account: Optional[str] = APIField(None)
    domain: Optional[str] = APIField(None)
    icon: Optional[str] = APIField(None)
