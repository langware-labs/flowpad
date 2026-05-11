"""Shared hub auth state transitions."""

from __future__ import annotations

from flow_sdk.api.messages import AuthExpiredMessage


async def broadcast_auth_expired(reason: str) -> None:
    """Notify local UI clients that hub auth is no longer usable."""
    try:
        from flow_sdk.server.routes.websocket import broadcast

        await broadcast(AuthExpiredMessage(reason=reason).model_dump_json())
    except Exception:
        pass


async def invalidate_hub_login(reason: str) -> None:
    """Clear canonical hub login state and broadcast the local UI invalidation."""
    from flow_sdk.cli.auth.cloud_login import clear_cloud_credentials

    clear_cloud_credentials()
    await broadcast_auth_expired(reason)
