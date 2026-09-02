"""Projection of the canonical local+Hub OAuth table into SDK DTOs."""

from __future__ import annotations

from typing import Optional

from flow_sdk.core.connections.types import (
    ConnectionConnectError,
    ConnectionSpec,
    ConnectionStage,
    ConnectionTokenResult,
    ConnectionTokenStatus,
)
from flow_sdk.core.entity.entity_env.env_types import EnvStatusEnum


async def _connection_user():
    from flow_sdk.request_context.methods import get_current_request_user_fresh  # noqa: PLC0415

    user = await get_current_request_user_fresh()
    if user is not None:
        return user
    from flow_sdk.builtin.user import User  # noqa: PLC0415

    return await User.get_local()


def _display_name(row) -> str:
    explicit = str(getattr(row, "oauth_display_name", "") or "").strip()
    if explicit:
        return explicit
    description = str(row.description or "")
    prefix = "OAuth integration for "
    if description.startswith(prefix) and description[len(prefix) :].strip():
        return description[len(prefix) :].strip()
    return str(row.name).replace("_", " ").replace("-", " ").title()


async def _list_connection_specs_local() -> list[ConnectionSpec]:
    """Return exactly the providers visible in the canonical Connections table."""
    from flow_sdk.core.oauth import get_oauth_providers_as_env_table  # noqa: PLC0415

    table = await get_oauth_providers_as_env_table(await _connection_user())
    return [
        ConnectionSpec(
            provider=row.name,
            display_name=_display_name(row),
            credential_ref=row.ref_name or "",
            connected=row.var_status == EnvStatusEnum.AVAILABLE and not row.needs_reauth,
            identity=None,
            scopes=tuple(row.oauth_scopes or ()),
            icon=row.icon,
        )
        for row in table.values
        if row.name and row.ref_name
    ]


async def _list_connection_specs_with_client(client) -> list[ConnectionSpec]:
    response = await client.request("GET", "/api/v1/graph/oauth/_/catalogue")
    if not response.success or not isinstance(response.data, dict):
        raise ConnectionConnectError(
            "",
            ConnectionStage.CATALOG,
            response.error_code or "catalog_unavailable",
            response.message or "Connection catalogue is unavailable",
        )
    values = response.data.get("values")
    if not isinstance(values, list):
        raise ConnectionConnectError(
            "",
            ConnectionStage.CATALOG,
            "invalid_response",
            "Connection catalogue returned invalid values",
        )
    return [ConnectionSpec(**value) for value in values if isinstance(value, dict)]


async def list_connection_specs() -> list[ConnectionSpec]:
    """Read the canonical catalogue through the selected local service."""
    from flow_sdk.core.connections.service import FlowServiceError, flow_service  # noqa: PLC0415

    try:
        async with flow_service() as lease:
            return await _list_connection_specs_with_client(lease.client)
    except FlowServiceError as exc:
        raise ConnectionConnectError("", ConnectionStage.SERVICE, exc.code, exc.detail) from exc


async def resolve_connection_spec(provider: str) -> Optional[ConnectionSpec]:
    wanted = (provider or "").strip().lower()
    return next(
        (spec for spec in await list_connection_specs() if spec.provider.strip().lower() == wanted),
        None,
    )


async def _token_for_spec_local(spec: ConnectionSpec) -> Optional[str]:
    """Resolve a spec's canonical credential reference without provider logic."""
    from flow_sdk.core.oauth.hub_oauth import hub_credential_value  # noqa: PLC0415
    from flow_sdk.core.oauth.provider_probe import token_from_credential  # noqa: PLC0415
    from flow_sdk.request_context.methods import get_user_credentials  # noqa: PLC0415

    user = await _connection_user()
    if user is not None:
        try:
            stored = await get_user_credentials(user, spec.credential_ref, user.id)
            token = token_from_credential(stored)
            if token:
                return token
        except Exception:  # noqa: BLE001 — absence falls through to the Hub tier
            pass
    return token_from_credential(await hub_credential_value(spec.credential_ref))


async def token_for_spec(spec: ConnectionSpec) -> ConnectionTokenResult:
    """Resolve a fresh token state through the selected local service."""
    from flow_sdk.core.connections.service import FlowServiceError, flow_service  # noqa: PLC0415

    try:
        async with flow_service() as lease:
            response = await lease.client.request("GET", f"/api/v1/graph/oauth/{spec.provider}/token")
            if not response.success or not isinstance(response.data, dict):
                raise ConnectionConnectError(
                    spec.provider,
                    ConnectionStage.SECRETS,
                    response.error_code or "token_lookup_failed",
                    response.message,
                )
            try:
                status = ConnectionTokenStatus(str(response.data.get("status") or ""))
            except ValueError as exc:
                raise ConnectionConnectError(
                    spec.provider,
                    ConnectionStage.SECRETS,
                    "invalid_response",
                    "Token lookup returned an invalid status",
                ) from exc
            value = response.data.get("token")
            return ConnectionTokenResult(status=status, token=str(value) if value else None)
    except FlowServiceError as exc:
        raise ConnectionConnectError(spec.provider, ConnectionStage.SERVICE, exc.code, exc.detail) from exc
