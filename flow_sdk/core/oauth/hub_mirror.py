"""Encrypted local copies whose refresh authority remains the originating hub."""

from typing import Any

from flow_sdk.cloud_client.client import ApiConfig
from flow_sdk.core.oauth.hub_providers import _cloud_user_id

_MARKER = "_flowpad_hub_mirror"


class HubMirrorUnavailable(RuntimeError):
    """An adopted credential cannot be resolved; do not change principals."""


def hub_mirror(token: str, credential_name: str) -> dict[str, Any]:
    """Bind a local copy to the cloud account and server that issued it."""
    user_id = _cloud_user_id()
    if not user_id:
        raise RuntimeError("Cannot mirror an OAuth token without a cloud account")
    return {
        "access_token": token,
        _MARKER: {
            "credential_name": credential_name,
            "user_id": user_id,
            "api_base_url": ApiConfig.from_env().api_base_url,
        },
    }


async def resolve_hub_mirror(value: Any) -> tuple[Any, Any]:
    """Return (usable token, updated storage value), refusing stale copies.

    The hub value route refreshes expiring grants. Resolve there before using
    a mirrored token and persist the refreshed value locally. This introduces
    no polling: one resolution follows the existing hub credential read path.
    A different account or server must never refresh this account's copy.
    """
    if not isinstance(value, dict) or _MARKER not in value:
        return value, value
    source = value[_MARKER]
    if (
        not isinstance(source, dict)
        or source.get("user_id") != _cloud_user_id()
        or source.get("api_base_url") != ApiConfig.from_env().api_base_url
        or not source.get("credential_name")
    ):
        raise HubMirrorUnavailable("OAuth connection belongs to a different cloud account or server")

    from flow_sdk.core.oauth.hub_oauth import hub_credential_value  # noqa: PLC0415

    token = await hub_credential_value(source["credential_name"], verify_held=False)
    if not token:
        raise HubMirrorUnavailable("The hub could not resolve this OAuth connection")
    return token, {**value, "access_token": token}
