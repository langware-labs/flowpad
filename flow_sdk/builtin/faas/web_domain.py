from __future__ import annotations

import types
from typing import TYPE_CHECKING, ClassVar, List, Optional

from flow_sdk import service_log
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.config import default_service_config
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.db_entity import DBEntity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.type_id import TypeId

if TYPE_CHECKING:
    from flow_sdk.core.entity.entity_model import EntityType


class WebDomain(Entity):
    type: str = BuiltinEntityType.WEB_DOMAIN.value
    domain: str = APIField()
    verified: bool = False
    micro_app_id: str = APIField()
    _api_visible: ClassVar[bool] = True

    _unique: ClassVar[List[str]] = ["domain"]

    @classmethod
    async def get_by_domain(cls, domain: str) -> Optional["WebDomain"]:
        return await cls.get_one({"domain": domain})

    async def save(self: "EntityType", owner: DBEntity | TypeId | types.NoneType = None, notify: bool = True) -> "EntityType":
        """
        Auto-verify domains ending with app_domain.
        If the domain ends with the configured app_domain, automatically set verified=True.
        """
        if not isinstance(self, WebDomain):
            raise TypeError("WebDomain object expected")

        self.domain = self.domain.split(":")[0]
        if self.domain and not self.verified:
            micro_app_domain = default_service_config.micro_app_domain_config.app_domain
            if self.domain.endswith(f".{micro_app_domain}"):
                self.verified = True
                service_log.info(f"Auto-verifying WebDomain: {self.domain} (matches app_domain: {micro_app_domain})")

        return await super().save(owner, notify=notify)
