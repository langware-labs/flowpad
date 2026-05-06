"""Cloud login chokepoint.

``cloud_login()`` is the single entry point. Internally it picks env-mode
(POST cloud /login with ``FLOWPAD_CLOUD_USER_EMAIL`` /
``FLOWPAD_CLOUD_USER_PASSWORD``) or browser-mode (open the system browser
to the cloud's login form, wait for the cloud's redirect to
``/auth/login_callback``).

Both paths converge on ``_finalize_login``, which broadcasts the success
WS event and persists the bearer token + user.
"""

from __future__ import annotations

import asyncio
import webbrowser
from typing import Any
from urllib.parse import urlparse

from flow_sdk.api.messages import OAuthMessage, OAuthMessageStatus
from flow_sdk.api.oauth_api import OAuthProvider
from flow_sdk.cli.app_config import set_user
from flow_sdk.cli.auth.cloud_urls import get_login_url
from flow_sdk.cli.auth.hub_login import set_api_key
from flow_sdk.cloud_client import ApiConfig, FlowpadClient
from flow_sdk.instance_settings import get_instance_settings


def _classify_hub(api_base_url: str | None) -> str:
    """Classify the configured hub: ``"cloud"`` (flowpad.ai), ``"local"`` (loopback), or ``"unsupported"``."""
    host = (urlparse(api_base_url or "").hostname or "").lower()
    if host == "flowpad.ai" or host.endswith(".flowpad.ai"):
        return "cloud"
    if host in ("localhost", "127.0.0.1", "::1"):
        return "local"
    return "unsupported"


async def cloud_login() -> dict[str, Any]:
    """Route by hub URL: flowpad.ai → browser/Auth0, localhost → env-mode creds, else error.

    Returns ``{status: "logged_in", user}`` (local) or ``{status: "started", url}`` (cloud).
    Browser-mode result arrives later via OAuthMessage WS broadcast.
    """
    settings = get_instance_settings()
    hub_url = ApiConfig.from_env().api_base_url
    kind = _classify_hub(hub_url)

    if kind == "cloud":
        return await _login_by_window(settings.port, settings.cloud_login_timeout_seconds)

    if kind == "local":
        if not (settings.cloud_user_email and settings.cloud_user_pass):
            raise ValueError("Local hub login requires FLOWPAD_CLOUD_USER_EMAIL and FLOWPAD_CLOUD_USER_PASSWORD")
        return await _login_by_api(settings.cloud_user_email, settings.cloud_user_pass)

    raise ValueError(f"Login not supported for hub URL: {hub_url}")


async def _login_by_api(email: str, password: str) -> dict[str, Any]:
    token, user_info = await _post_cloud_login(email, password)
    await _finalize_login(token, user_info)
    return {"status": "logged_in", "user": user_info}


async def _login_by_window(port: int, timeout: float) -> dict[str, Any]:
    # Race window: the cloud could redirect-back before this function returns,
    # so reset the waiter state BEFORE opening the browser.
    from flow_sdk.server import state
    state.login_received.clear()
    state.login_result = None
    asyncio.create_task(_wait_or_timeout(timeout))

    url = get_login_url(f"http://127.0.0.1:{port}/auth/login_callback")
    await asyncio.to_thread(webbrowser.open, url)
    return {"status": "started", "url": url}


async def _wait_or_timeout(timeout: float) -> None:
    from flow_sdk.server import state
    success = await asyncio.to_thread(state.login_received.wait, timeout)
    if not success:
        await _broadcast_oauth_error(f"Login timed out after {int(timeout)}s — please try again")


async def _post_cloud_login(email: str, password: str) -> tuple[str, dict[str, Any]]:
    """POST cloud /login. Returns ``(token, user_info)`` from the LoginData payload."""
    config = ApiConfig.from_env()
    async with FlowpadClient(config) as client:
        data = await client.post("/login", {"email": email, "password": password})
    if not isinstance(data, dict) or not data.get("token") or not data.get("user"):
        raise ValueError(f"login response missing token/user: {data!r}")
    return data["token"], data["user"]


async def _finalize_login(token: str, user_info: dict[str, Any]) -> None:
    """Broadcast SUCCESS first (UI un-blocks immediately), then persist locally.

    set_api_key may trigger an OS keychain prompt that blocks for seconds —
    don't make WS subscribers wait on it. The WS payload carries user_info,
    so the UI doesn't need the keyring read to render logged-in state.
    """
    from flow_sdk.server import state
    from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache

    await _broadcast_oauth(OAuthMessage(
        oauth_request_id=OAuthProvider.FLOWPAD_CLOUD,
        status=OAuthMessageStatus.SUCCESS,
        user=user_info,
    ))

    set_api_key(token)
    # If the keyring write succeeded, mark the secrets-enabled sentinel so
    # is_cloud_login_available() can read the key on subsequent boots.
    # enable_secrets() swallows its own keyring errors and returns a bool,
    # so we don't need a try/except here.
    from flow_sdk.cli.auth.secrets import enable_secrets
    enable_secrets()
    set_user(user_info)
    state.login_result = {"success": True, "user": user_info, "message": "Login successful"}
    state.login_received.set()
    invalidate_bootstrap_cache()


async def _broadcast_oauth(msg: OAuthMessage) -> None:
    try:
        from flow_sdk.server.routes.websocket import broadcast
        await broadcast(msg.model_dump_json())
    except Exception:
        pass


async def _broadcast_oauth_error(message: str) -> None:
    await _broadcast_oauth(OAuthMessage(
        oauth_request_id=OAuthProvider.FLOWPAD_CLOUD,
        status=OAuthMessageStatus.ERROR,
        message=message,
    ))


def clear_cloud_credentials() -> None:
    """Delete keyring api-key, blank user JSON, reset waiter state, invalidate bootstrap cache.

    Used by ``/api/v1/cloud/logout``, ``/api/v1/cloud/logout_callback``, and the
    legacy ``flowpad_cloud/disconnect`` action handler — single owner.
    """
    from flow_sdk.cli.auth.hub_login import delete_api_key
    from flow_sdk.server import state
    from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache

    delete_api_key()
    set_user({})
    state.login_result = None
    state.login_received.clear()
    invalidate_bootstrap_cache()
