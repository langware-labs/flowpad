"""WebDomain — a host name routed to a ServiceEndpoint.

The hub serves a ``web.*`` endpoint on its own origin (``<id>.<app_domain>``
or a custom domain) and owns verification. The desktop carries the same shape
so the row reads the same on both tiers (the bootstrap ships one as
``domain``); it serves nothing by host name itself.
"""

from __future__ import annotations

from typing import ClassVar, List, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class WebDomain(Entity):
    type: str = BuiltinEntityType.WEB_DOMAIN.value
    domain: str = APIField()
    verified: bool = APIField(default=False)
    service_endpoint_id: Optional[str] = APIField(default=None, description="The endpoint this host name serves")
    _api_visible: ClassVar[bool] = True

    _unique: ClassVar[List[str]] = ["domain"]

    @classmethod
    async def get_by_domain(cls, domain: str) -> Optional["WebDomain"]:
        return await cls.get_one({"domain": domain})
