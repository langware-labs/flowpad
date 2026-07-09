"""SecretOrigin entity: a project-level secret pointer.

This entity stores pointer metadata only. The actual secret value stays in the
receiver's value store and is resolved only while launching a worker process.
"""
from __future__ import annotations

import re
from typing import Any

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.local_secret_ref import LocalSecretRef
from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER, SecretOriginField
from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType

SECRET_ORIGIN_ENV_VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def is_valid_secret_origin_env_var(env_var: str) -> bool:
    return bool(SECRET_ORIGIN_ENV_VAR_RE.fullmatch(env_var))


class SecretOrigin(Entity):
    type: str = APIField(default=EntityType.SECRET_ORIGIN.value)
    env_var: str = APIField(default="", description="Environment variable injected for workers")
    locator: SecretOriginField = APIField(
        default_factory=LocalSecretRef,
        description="Value-free secret locator",
    )

    @staticmethod
    def id_for_locator(locator: SecretOriginLocator) -> str:
        return locator.key()

    @staticmethod
    def context_data_for(
        *,
        name: str,
        env_var: str,
        locator: SecretOriginLocator,
        scope: str,
        typeid: str | None = None,
    ) -> dict[str, Any]:
        data: dict[str, Any] = {
            "name": name,
            "env_var": env_var,
            "kind": locator.kind,
            "locator": locator.model_dump(mode="json"),
            "scope": scope,
        }
        if typeid:
            data["typeid"] = typeid
        return data

    def context_data(self, *, scope: str) -> dict[str, Any]:
        return self.context_data_for(
            name=self.name or "",
            env_var=self.env_var,
            locator=self.locator,
            scope=scope,
            typeid=str(self.typeid),
        )

    @classmethod
    async def mint_for(
        cls,
        *,
        locator: SecretOriginLocator | dict[str, Any],
        name: str,
        env_var: str,
        remote: bool = False,
    ) -> "SecretOrigin":
        loc = SECRET_ORIGIN_ADAPTER.validate_python(locator)
        secret_id = cls.id_for_locator(loc)
        existing = await cls.get_by_id(secret_id)
        if existing is not None:
            changed = False
            if existing.name != name:
                existing.name = name
                changed = True
            if existing.env_var != env_var:
                existing.env_var = env_var
                changed = True
            if existing.locator.model_dump(mode="json") != loc.model_dump(mode="json"):
                existing.locator = loc
                changed = True
            if remote and not existing.remote:
                existing.remote = True
                changed = True
            if changed:
                await existing.save()
            return existing

        ent = cls(id=secret_id, name=name, env_var=env_var, locator=loc, remote=remote)
        await ent.save()
        return ent
