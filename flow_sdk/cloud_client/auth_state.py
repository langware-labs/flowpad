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


def login_block() -> dict:
    """Who this instance is signed in as: ``{status, user, reason}``.

    THE answer to "who am I", in one place. It was assembled inline inside
    ``GET /api/v1/cloud/status`` and nowhere else, which is why the graph
    bootstrap could not say it — and why a sandbox painted its template-local user
    ("E2B Local") until a second, asynchronous request arrived to correct it. On a
    cold resume that request races a still-waking backend and loses.

    Both inputs are file-based and keychain-safe (``is_logged_in`` says so in its
    own docstring), so this is cheap enough to sit on the cold-start bootstrap
    path — unlike ``is_cloud_login_available``, the network probe already there.

    The disk-vs-memory heal moved here with it: the in-memory mirror is seeded
    lazily and can lag on a fresh boot before any transition has been emitted, so
    DISK WINS. Leaving that behind in the route would have meant two callers
    disagreeing about the same fact, which is the bug this function exists to end.
    """
    from flow_sdk.cli.app_config import get_user
    from flow_sdk.cli.auth.hub_login import is_logged_in

    # `is_logged_in()` is `bool(get_user())`, so this reads the config file twice
    # and could be one call. It is deliberately left as two: the named predicate is
    # what states the intent, and it is the seam callers and tests patch to mean
    # "this instance is signed out". Both reads are of a small already-warm file on
    # a path that also makes a network probe (`is_cloud_login_available`), so the
    # saving would be noise and the coupling would be real.
    logged_in = is_logged_in()
    status = current_login_status()
    if logged_in and status != HubLoginStatus.LOGGED_IN:
        status = HubLoginStatus.LOGGED_IN
    elif not logged_in and status == HubLoginStatus.LOGGED_IN:
        status = HubLoginStatus.LOGGED_OUT

    return {
        "status": status.value,
        "user": get_user() if logged_in else None,
        "reason": None,
    }


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
