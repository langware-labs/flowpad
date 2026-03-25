import logging
from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Comment(Entity):
    type: str = APIField(default=BuiltinEntityType.COMMENT.value)
    raw_content: Optional[str] = APIField(default=None, blob=True)
    _api_visible: ClassVar[bool] = True
