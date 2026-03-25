import logging
from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity


class Integration(Entity):
    type: str = APIField(default="integration")
    auth_type: str | None = APIField(None)
    provider: str | None = APIField(None)
    name: str | None = APIField(None)
    _api_visible: ClassVar[bool] = True
