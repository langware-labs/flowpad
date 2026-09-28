"""``hub`` — a cloud deployment's values, held by the hub (its confidential env vars, in the hub SOD).

The store a cloud deployment keeps its values in. From here a value goes IN (``save``: "use mine",
``flow credentials set --deployment``) and can be removed (``forget``); names can be listed. A value
never comes back out: ``load`` answers nothing — the hub places the values on the deployment's machine
when it starts, and that machine reads them from its own env file.
"""
from __future__ import annotations

import logging
from typing import Any, ClassVar, Iterable, Mapping

from pydantic import ConfigDict, Field, SecretStr

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.store import SecretStore, plain_values, register_store

logger = logging.getLogger(__name__)

#: The hub's confidential kinds: a stored value, never a plain variable.
_CONFIDENTIAL = ("api_key", "oauth_token")


class HubStoreConfig(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "secrets.hub"

    #: The hub Deployment (its id) whose store this is.
    deployment_id: str = Field(min_length=1)


@register_store
class HubStore(SecretStore):
    type_name: ClassVar[str] = "hub"
    config_spec: ClassVar[type[DataSpec]] = HubStoreConfig
    config: HubStoreConfig

    @property
    def where(self) -> str:
        return f"hub deployment {self.config.deployment_id}"

    async def _rows(self) -> list[dict]:
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

        # Raises on an unreachable hub: an outage must not read as "holds nothing" (a save would then
        # create instead of update, a forget would report success).
        rows = await hub_get_or_raise(BuiltinEntityType.DEPLOYMENT, self.config.deployment_id, action="env-var")
        return [r for r in rows or [] if isinstance(r, dict) and r.get("var_type") in _CONFIDENTIAL]

    async def load(self, names: Iterable[str]) -> dict[str, SecretStr]:
        """Nothing: a value stored on the hub is only ever placed on the deployment's machine."""
        return {}

    async def names(self) -> list[str]:
        return [str(r.get("name")) for r in await self._rows()]

    async def save(self, values: Mapping[str, Any], *, description: str = "") -> None:
        from flow_sdk.cloud_client.transport.hub_http import hub_post, hub_put  # noqa: PLC0415
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

        held = set(await self.names())
        for name, value in plain_values(values).items():
            if name in held:
                await hub_put(BuiltinEntityType.DEPLOYMENT, self.config.deployment_id, {"value": value},
                              action="env-var", sub_path=name)
            else:
                await hub_post(BuiltinEntityType.DEPLOYMENT,
                               {"name": name, "var_type": "api_key", "value": value, "description": description or name},
                               self.config.deployment_id, action="env-var")

    async def forget(self, names: Iterable[str]) -> tuple[list[str], list[str]]:
        from flow_sdk.cloud_client.shared.errors import HubError  # noqa: PLC0415
        from flow_sdk.cloud_client.transport.hub_http import hub_delete  # noqa: PLC0415
        from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

        held = set(await self.names())
        deleted: list[str] = []
        kept: list[str] = []
        for name in names:
            if name not in held:
                continue
            try:
                await hub_delete(BuiltinEntityType.DEPLOYMENT, self.config.deployment_id, action="env-var", sub_path=name)
                deleted.append(name)
            except HubError as e:
                logger.warning("[secrets] the hub kept %s: %s", name, e.status_code)
                kept.append(name)
        return deleted, kept


__all__ = ["HubStore", "HubStoreConfig"]
