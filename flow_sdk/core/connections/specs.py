"""Projection of the canonical local+Hub OAuth table into SDK DTOs."""

from __future__ import annotations

from typing import Optional
from urllib.parse import quote

from flow_sdk.core.connections.types import (
    ConnectionConnectError,
    ConnectionKind,
    ConnectionSpec,
    ConnectionStage,
    ConnectionState,
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


def _oauth_state(row) -> ConnectionState:
    """A grant's three readings, from the one env row that knows them."""
    if row.needs_reauth:
        return ConnectionState.NEEDS_REAUTH
    if row.var_status == EnvStatusEnum.AVAILABLE:
        return ConnectionState.CONNECTED
    return ConnectionState.DISCONNECTED


async def _list_connection_specs_local() -> list[ConnectionSpec]:
    """Return exactly the providers visible in the canonical Connections table."""
    from flow_sdk.core.oauth import get_oauth_providers_as_env_table  # noqa: PLC0415

    table = await get_oauth_providers_as_env_table(await _connection_user())
    return [
        ConnectionSpec(
            provider=row.name,
            display_name=_display_name(row),
            kind=ConnectionKind.OAUTH,
            state=_oauth_state(row),
            credential_ref=row.ref_name or "",
            connected=_oauth_state(row) is ConnectionState.CONNECTED,
            identity="",
            scopes=tuple(row.oauth_scopes or ()),
            icon=row.icon or "",
        )
        for row in table.values
        if row.name and row.ref_name
    ]


async def _fetch_rows(client, path: str, key: str, what: str) -> list[ConnectionSpec]:
    """GET *path* through a leased local service and project ``data[key]``."""
    response = await client.request("GET", path)
    if not response.success or not isinstance(response.data, dict):
        raise ConnectionConnectError(
            "",
            ConnectionStage.CATALOG,
            response.error_code or "catalog_unavailable",
            response.message or f"Connection {what} is unavailable",
        )
    values = response.data.get(key)
    if not isinstance(values, list):
        raise ConnectionConnectError(
            "", ConnectionStage.CATALOG, "invalid_response", f"Connection {what} returned invalid values"
        )
    return [ConnectionSpec.from_wire(value) for value in values if isinstance(value, dict)]


async def _list_connection_specs_with_client(client) -> list[ConnectionSpec]:
    return await _fetch_rows(client, "/api/v1/graph/oauth/_/catalogue", "values", "catalogue")


async def _list_connections_with_client(client, project_id: str = "") -> list[ConnectionSpec]:
    query = f"?project_id={quote(project_id, safe='')}" if project_id else ""
    return await _fetch_rows(
        client, f"/api/v1/graph/compute_node/@local/connections{query}", "connections", "list"
    )


async def _leased(fetch):
    """Run *fetch(client)* against the selected local service, typing its failure."""
    from flow_sdk.core.connections.service import FlowServiceError, flow_service  # noqa: PLC0415

    try:
        async with flow_service() as lease:
            return await fetch(lease.client)
    except FlowServiceError as exc:
        raise ConnectionConnectError("", ConnectionStage.SERVICE, exc.code, exc.detail) from exc


async def list_connections(project_id: str = "") -> list[ConnectionSpec]:
    """Every connection this box HAS — all four kinds, consolidated by the backend.

    Distinct from :func:`list_connection_specs`, and the distinction is the same
    one the screen makes between its table and its Add dialog: this is what you
    have, that is the catalogue of what you could connect. A provider you have
    never authorized is in the catalogue and not in this list, which is exactly
    why ``connect`` cannot be built on it.
    """
    return await _leased(lambda client: _list_connections_with_client(client, project_id))


async def list_connection_specs() -> list[ConnectionSpec]:
    """Read the canonical OAuth CATALOGUE — every provider, connected or not.

    The connect/test state machines run off this: you authorize a provider you do
    NOT yet hold, so a held-only list could never serve them. For "what does this
    box have", use :func:`list_connections`.
    """
    return await _leased(_list_connection_specs_with_client)


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
