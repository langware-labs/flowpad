"""Resolves a declaration whose value lives on the hub.

The hub is the system of record; this is the client side of that. It replaces
the ``ProviderStubDriver`` slot that returned ``None`` for every hub-kind
declaration.

Two deliberate choices:

**No caching.** Every worker launch re-asks the hub. A cache would make a
revoked grant keep working for however long the entry lived, and "revoke takes
effect now" is worth more than one round trip at spawn.

**``can_resolve`` does not fetch.** The Secrets card calls it per secret on
every render, and the value route is consent-gated and audited — hammering it
to paint a status chip would fill the audit log with reads nobody asked for.
Existence is answered from the project's env-var table, which returns masked
metadata only.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from pydantic import SecretStr

from flow_sdk.builtin.secret_origin_driver import make_setup_hint
from flow_sdk.builtin.secret_origin_refs import SecretOriginLocator

logger = logging.getLogger(__name__)

COORD_FIELDS = ("project_id", "name")


def _coords(locator: SecretOriginLocator, project) -> tuple[str, str] | None:
    """``(project_id, name)`` for the hub row, or ``None`` if unaddressable."""
    project_id = (getattr(locator, "project_id", "") or "").strip()
    name = (getattr(locator, "name", "") or "").strip()
    if not project_id and project is not None:
        project_id = str(getattr(project, "id", "") or "")
    if not name:
        # A declaration is named by its env var, so the secret's hub name is it.
        name = (getattr(locator, "secret_id", "") or "").strip()
    if not project_id or not name:
        return None
    return project_id, name


async def _hub_env_var(project_id: str, sub_path: Optional[str] = None) -> Any:
    """GET the project's env-var surface on the hub, unwrapped. ``None`` on any
    failure — a hub that is down must not take a worker spawn with it."""
    from flow_sdk.cloud_client.transport.hub_http import hub_get  # noqa: PLC0415
    from flow_sdk.db.drivers.db_base_record import BuiltinEntityType  # noqa: PLC0415

    try:
        payload = await hub_get(
            BuiltinEntityType.PROJECT, project_id, action="env-var", sub_path=sub_path
        )
    except Exception as e:  # noqa: BLE001
        logger.debug("[hub-secret] fetch failed (%s): %s", sub_path or "table", e)
        return None
    if not isinstance(payload, dict):
        return None
    return payload.get("data", payload)


class HubSecretDriver:
    """Fetches a hub-held value with the CALLER's own hub credentials."""

    kind = "flowpad-hub"

    async def resolve(self, locator: SecretOriginLocator, **context: Any) -> Optional[SecretStr]:
        coords = _coords(locator, context.get("project"))
        if coords is None:
            return None
        project_id, name = coords

        data = await _hub_env_var(project_id, f"{name}/value")
        value = data.get("value") if isinstance(data, dict) else None
        return SecretStr(value) if value else None

    async def can_resolve(self, locator: SecretOriginLocator, **context: Any) -> bool:
        """Existence only — never the gated value route. See the module docstring."""
        coords = _coords(locator, context.get("project"))
        if coords is None:
            return False
        project_id, name = coords

        rows = await _hub_env_var(project_id)
        if not isinstance(rows, list):
            return False
        return any(isinstance(r, dict) and r.get("name") == name for r in rows)

    def setup_hint(self, locator: SecretOriginLocator) -> dict[str, Any]:
        return make_setup_hint(
            self.kind,
            sod_store="sodot",
            provider_label="Flowpad Hub",
            prompt="Stored on the hub. Push a value from this project, or paste one to cache it locally.",
            coord_fields=COORD_FIELDS,
        )

    async def store(self, locator: SecretOriginLocator, value: str, **context: Any) -> None:
        """Writing a hub-held value goes through ``push-secret-to-cloud``, which
        owns the publication gate. Falling back to a local cache here would
        quietly create a second copy the hub never sees."""
        from flow_sdk.builtin.secret_origin_driver import SecretProvideUnsupported  # noqa: PLC0415

        raise SecretProvideUnsupported(
            "Use 'push to cloud' to store a hub secret — it checks the project is published first."
        )
