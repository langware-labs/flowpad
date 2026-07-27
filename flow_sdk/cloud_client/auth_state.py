"""Hub auth state transitions — orthogonal login + connection status funnels."""

from __future__ import annotations

import logging

from flow_sdk.api.messages import AuthExpiredMessage

from flow_sdk import inbox
from flow_sdk.cloud_client.auth_status import (
    CloudConnectionStatusMessage,
    CloudLoginStatusMessage,
    HubConnectionStatus,
    HubLoginStatus,
)

logger = logging.getLogger(__name__)


# In-memory mirror of the canonical login status. Populated from on-disk
# state on first read via ``current_login_status()`` (no broadcast); kept
# in sync by ``set_login_status()``.
_login_status: HubLoginStatus | None = None


def _initial_login_status() -> HubLoginStatus:
    try:
        from flow_sdk.cli.auth.hub_login import is_logged_in
        return HubLoginStatus.LOGGED_IN if is_logged_in() else HubLoginStatus.LOGGED_OUT
    except Exception:
        return HubLoginStatus.LOGGED_OUT


def current_login_status() -> HubLoginStatus:
    global _login_status
    if _login_status is None:
        _login_status = _initial_login_status()
    return _login_status


async def broadcast_auth_expired(reason: str) -> None:
    """Legacy back-compat broadcast — kept for one release alongside CloudLoginStatusMessage."""
    try:
        from flow_sdk.server.routes.websocket import broadcast
        await broadcast(AuthExpiredMessage(reason=reason).model_dump_json())
    except Exception:
        pass


async def set_login_status(
    status: HubLoginStatus,
    *,
    user: dict | None = None,
    reason: str | None = None,
) -> None:
    """Update + broadcast the hub login status. Single funnel for login transitions.

    Broadcasts ``CloudLoginStatusMessage`` to local UI clients. When the new
    status is ``LOGGED_OUT``, also emits the legacy ``AuthExpiredMessage`` for
    one release of back-compat.
    """
    global _login_status
    _login_status = status

    try:
        from flow_sdk.server.routes.websocket import broadcast
        msg = CloudLoginStatusMessage(status=status, user=user, reason=reason)
        await broadcast(msg.model_dump_json())
    except Exception:
        pass

    # Login transitions change viewer identity, which changes which
    # invitations/messages count as unread — repair the projection here so a
    # stale account can't keep driving the badge.
    inbox.touch(f"login-status:{status.value if hasattr(status, 'value') else status}")

    if status == HubLoginStatus.LOGGED_OUT:
        await broadcast_auth_expired(reason or "logged_out")


async def set_connection_status(
    status: HubConnectionStatus,
    *,
    error: str | None = None,
) -> None:
    """Broadcast the hub WS connection status. Single funnel for connection transitions.

    Does NOT touch login state. The source of truth for connection state
    lives in ``HubWebSocketManager``; this function only publishes transitions.
    """
    try:
        from flow_sdk.server.routes.websocket import broadcast
        msg = CloudConnectionStatusMessage(status=status, error=error)
        await broadcast(msg.model_dump_json())
    except Exception:
        pass
    # Unified-bus dual-publish (docs/flow-events.md phase 6): node liveness —
    # deterministic local-node target, zero DB work (see node_on_tag.py).
    from flow_sdk.cloud_client.node_on_tag import emit_node_transition

    emit_node_transition(status.value, error)


async def invalidate_hub_login(reason: str) -> None:
    """Real credential loss: clear keyring + login_status → LOGGED_OUT.

    Delegates to ``clear_cloud_credentials`` so the WS is stopped and both
    statuses (login + connection) are broadcast in the right order, with
    ``reason`` carried into the login broadcast for UI copy / telemetry.
    """
    from flow_sdk.cli.auth.cloud_login import clear_cloud_credentials
    await clear_cloud_credentials(reason=reason)
