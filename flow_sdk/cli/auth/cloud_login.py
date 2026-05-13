"""Cloud login chokepoint.

``cloud_login()`` is the single entry point. Internally it picks env-mode
(POST cloud /login with ``FLOWPAD_CLOUD_USER_EMAIL`` /
``FLOWPAD_CLOUD_USER_PASSWORD``) or browser-mode (open the system browser
to the cloud's login form, wait for the cloud's redirect to
``/auth/login_callback``).

Both paths converge on ``_finalize_login``, which broadcasts the success
WS event and persists the hub credential payload + user mirror.
"""

from __future__ import annotations

import asyncio
import logging
import webbrowser
from typing import Any
from urllib.parse import urlparse

import httpx

from flow_sdk.api.messages import OAuthMessage, OAuthMessageStatus
from flow_sdk.api.oauth_api import OAuthProvider
from flow_sdk.cli.app_config import set_user
from flow_sdk.cli.auth.credentials import UserHubCredentials, load_credentials, save_credentials
from flow_sdk.cli.auth.cloud_urls import get_login_url
from flow_sdk.cli.auth.credentials import SERVICE_NAME, _api_key_name
from flow_sdk.cloud_client import ApiConfig, FlowpadClient
from flow_sdk.cloud_client.api.auth import LoginData
from flow_sdk.instance_settings import get_instance_settings

logger = logging.getLogger(__name__)


def _classify_hub(api_base_url: str | None) -> str:
    """Classify the configured hub: ``"cloud"`` (flowpad.ai), ``"local"`` (loopback), or ``"unsupported"``."""
    host = (urlparse(api_base_url or "").hostname or "").lower()
    if host == "flowpad.ai" or host.endswith(".flowpad.ai"):
        return "cloud"
    if host in ("localhost", "127.0.0.1", "::1", "host.docker.internal"):
        # ``host.docker.internal`` is Docker's stable alias for the host
        # loopback (with ``extra_hosts: host.docker.internal:host-gateway``
        # on Linux). Containerized backends in docker/docker-compose.yml use
        # this URL to reach the hub running on the dev host.
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
            raise ValueError(
                "Cloud is not configured. Set FLOWPAD_CLOUD_USER_EMAIL and "
                "FLOWPAD_CLOUD_USER_PASSWORD in .env.local and restart the app."
            )
        return await _login_by_api(settings.cloud_user_email, settings.cloud_user_pass)

    raise ValueError(f"Cloud sign-in isn't supported for this hub URL: {hub_url}")


async def _login_by_api(email: str, password: str) -> dict[str, Any]:
    login_data = await _post_cloud_login(email, password)
    await _finalize_login(login_data)
    return {"status": "logged_in", "user": login_data.user}


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


async def _post_cloud_login(email: str, password: str) -> LoginData:
    """POST cloud /login and return the full LoginData payload.

    Translates raw transport / non-success envelope failures into
    user-friendly RuntimeError messages so the UI surfaces clear copy in
    both the warnings popover and the hub-client-error toast, rather than
    httpx's "All connection attempts failed" stack-trace text.
    """
    config = ApiConfig.from_env()
    try:
        async with FlowpadClient(config) as client:
            data = await client.post("/login", {"email": email, "password": password})
    except httpx.RequestError as e:
        # Transport failure — hub process is down, DNS resolution failed,
        # connection refused, network unreachable, etc.
        raise RuntimeError(
            "Cloud is not available. The hub server can't be reached — "
            "check your connection or try again in a moment."
        ) from e
    except ValueError as e:
        # ``FlowpadClient._unwrap`` raises ValueError for non-200 / non-success
        # envelopes. The envelope body is embedded in str(e); we sniff it for
        # the common credential / authz signals so the UI toast surfaces a
        # specific cause instead of a generic "try again".
        text = str(e)
        text_lower = text.lower()
        # Credential failure — hub returns this for wrong email/password on
        # either 401 (legacy) or 400 (current hub returns ``{"status":"FAIL",
        # "message":"Invalid Credentials, Check email or Password"}`` with
        # HTTP 400). Both map to the same user-facing surface.
        if (
            "invalid credentials" in text_lower
            or "check email or password" in text_lower
            or "401" in text
            or "unauthorized" in text_lower
            or "invalid token" in text_lower
        ):
            raise RuntimeError("Invalid email or password. Check your cloud credentials.") from e
        if "403" in text or "forbidden" in text_lower:
            raise RuntimeError("Cloud access denied for these credentials.") from e
        if "404" in text or "not found" in text_lower:
            raise RuntimeError("Cloud sign-in endpoint not found on the configured hub.") from e
        if "5" == text.strip()[:1] and any(s in text for s in (" 500", " 502", " 503", " 504")):
            raise RuntimeError("The cloud service returned an error. Please try again in a moment.") from e
        # As a last resort, try to extract the hub's own message field
        # from the embedded response body so the user sees what the hub
        # said rather than a generic fallback.
        import re as _re
        m = _re.search(r'"message"\s*:\s*"([^"]+)"', text)
        if m:
            raise RuntimeError(f"Cloud sign-in failed: {m.group(1)}") from e
        raise RuntimeError("Cloud sign-in failed. Please try again.") from e
    login_data = LoginData.model_validate(data)
    if not login_data.token or not login_data.user:
        raise RuntimeError("Cloud sign-in returned an unexpected response. Please try again.")
    return login_data


async def _finalize_login(login_data: LoginData) -> None:
    """Broadcast SUCCESS first (UI un-blocks immediately), then persist locally.

    save_credentials may trigger an OS keychain prompt that blocks for seconds —
    don't make WS subscribers wait on it. The WS payload carries user_info,
    so the UI doesn't need the keyring read to render logged-in state.
    """
    from flow_sdk.server import state
    from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache

    user_info = login_data.user
    await _broadcast_oauth(OAuthMessage(
        oauth_request_id=OAuthProvider.FLOWPAD_CLOUD,
        status=OAuthMessageStatus.SUCCESS,
        user=user_info,
    ))

    save_credentials(UserHubCredentials.from_login_data(login_data))
    # Read-back verification: if this logs FAILED on a system where the OS
    # prompt was silently bypassed, the keyring backend is broken (rare).
    stored = load_credentials()
    stored_ok = stored is not None and stored.api_key == login_data.token
    logger.info(
        "credentials write %s — keychain entry: service=%r account=%r",
        "OK" if stored_ok else "FAILED (read-back mismatch)",
        SERVICE_NAME,
        _api_key_name(),
    )
    # Sentinel flag so is_cloud_login_available() reads the key on next boot.
    # enable_secrets() swallows its own keyring errors and returns a bool,
    # so we don't need a try/except here.
    from flow_sdk.cli.auth.secrets import enable_secrets
    enable_secrets()
    set_user(user_info)
    state.login_result = {"success": True, "user": user_info, "message": "Login successful"}
    state.login_received.set()
    invalidate_bootstrap_cache()

    try:
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        await hub_ws_manager.restart()
    except Exception:
        pass


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
    from flow_sdk.cli.auth.credentials import clear_credentials
    from flow_sdk.server import state
    from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache

    try:
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        hub_ws_manager.request_stop()
    except Exception:
        pass

    clear_credentials()
    set_user({})
    state.login_result = None
    state.login_received.clear()
    invalidate_bootstrap_cache()
