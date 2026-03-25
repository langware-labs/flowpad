import logging
from typing import ClassVar, List, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import Entity


class AppHost(Entity):
    type: str = APIField(default=BuiltinEntityType.APP_HOST.value)
    domain: Optional[str] = APIField(None)
    app_type: Optional[str] = APIField(None)
    app_id: Optional[str] = APIField(None)
    _api_visible: ClassVar[bool] = False
    _unique: ClassVar[List[str]] = ["domain"]
