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
from flow_sdk.cli.auth.cloud_urls import desktop_login_callback_url, get_login_url
from flow_sdk.cli.auth.credentials import UserHubCredentials, load_credentials, save_credentials
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
    from flow_sdk.cloud_client.auth_state import set_login_status
    from flow_sdk.cloud_client.auth_status import HubLoginStatus

    await set_login_status(HubLoginStatus.LOGGING_IN)
    try:
        settings = get_instance_settings()
        hub_url = ApiConfig.from_env().api_base_url
        kind = _classify_hub(hub_url)

        if kind == "cloud":
            # Browser-mode: success/failure arrives later via the OAuth WS
            # callback. LOGGED_IN / LOGIN_FAILED are emitted from there
            # (_finalize_login on success, _broadcast_oauth_error on error).
            return await _login_by_window(settings.cloud_login_timeout_seconds)

        if kind == "local":
            has_email = bool(settings.cloud_user_email)
            has_password = bool(settings.cloud_user_pass)
            if has_email != has_password:
                raise ValueError(
                    "Local Hub login is partially configured. Set both "
                    "FLOWPAD_CLOUD_USER_EMAIL and FLOWPAD_CLOUD_USER_PASSWORD, or neither."
                )
            if has_email and has_password:
                return await _login_by_api(settings.cloud_user_email, settings.cloud_user_pass)
            return await _login_local()

        raise ValueError(f"Cloud sign-in isn't supported for this hub URL: {hub_url}")
    except Exception as exc:
        await set_login_status(HubLoginStatus.LOGIN_FAILED, reason=str(exc))
        raise


async def _login_by_api(email: str, password: str) -> dict[str, Any]:
    login_data = await _post_cloud_login(email, password)
    await _finalize_login(login_data)
    return {"status": "logged_in", "user": login_data.user}


async def _login_local() -> dict[str, Any]:
    """Use the local Hub's no-popup test/development login."""
    async with FlowpadClient(ApiConfig.from_env()) as client:
        data = await client.post("/login/local", {})
    login_data = LoginData.model_validate(data)
    if not login_data.token or not login_data.user:
        raise RuntimeError("Local Hub sign-in returned an unexpected response.")
    await _finalize_login(login_data)
    return {"status": "logged_in", "user": login_data.user}


async def _login_by_window(timeout: float) -> dict[str, Any]:
    # Race window: the cloud could redirect-back before this function returns,
    # so reset the waiter state BEFORE opening the browser.
    from flow_sdk.server import state

    state.login_received.clear()
    state.login_result = None
    asyncio.create_task(_wait_or_timeout(timeout))

    url = get_login_url(desktop_login_callback_url())
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
            "Cloud is not available. The hub server can't be reached — check your connection or try again in a moment."
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
    # Fold the hub-resolved organization id/role into the user dict so the
    # frontend ``currentUser`` carries them (the profile chip reads
    # ``currentUser.organization_id``). The org entity itself is materialized
    # below; here we only stamp the edge (id + role, default "member").
    if isinstance(user_info, dict) and login_data.organization:
        org_id = login_data.organization.get("id")
        if org_id:
            user_info["organization_id"] = org_id
            user_info["organization_role"] = login_data.organization_role or "member"

    await _broadcast_oauth(
        OAuthMessage(
            oauth_request_id=OAuthProvider.FLOWPAD_CLOUD,
            status=OAuthMessageStatus.SUCCESS,
            user=user_info,
        )
    )

    # Defensive: ensure consent marker exists before save_credentials writes
    # to instance.sod (which raises SecretsNotEnabledError without consent).
    # The canonical login flow has already passed through the bootstrap
    # explanation page → enable_secrets approval; this call is a no-op on
    # that path but covers any non-canonical caller that reaches here.
    from flow_sdk.cli.auth.secrets import enable_secrets

    enable_secrets()
    save_credentials(UserHubCredentials.from_login_data(login_data))
    # Read-back verification: confirms the sod write decrypts cleanly. Pass the
    # just-logged-in user id explicitly — the config.json active-user pointer
    # (set_user below) isn't committed yet, so a zero-arg load here would
    # resolve the PREVIOUS active user's scoped entries, not this login's.
    login_user_id = str(user_info["id"]) if isinstance(user_info, dict) and user_info.get("id") else None
    stored = load_credentials(login_user_id)
    stored_ok = stored is not None and stored.api_key == login_data.token
    sodot_path = get_instance_settings().sodot_path
    logger.info(
        "credentials write %s — sodot=%s",
        "OK" if stored_ok else "FAILED (read-back mismatch)",
        sodot_path,
    )
    set_user(user_info)
    # Materialize the user's organization locally as a remote=True row so the
    # Organization settings tab + member list resolve from a real entity.
    if login_data.organization:
        try:
            from flow_sdk.app.actions.membership_sync import materialize_remote_organization

            await materialize_remote_organization(login_data.organization)
        except Exception as e:  # noqa: BLE001
            logger.warning("org materialize on login failed: %s", e)
    state.login_result = {"success": True, "user": user_info, "message": "Login successful"}
    state.login_received.set()
    invalidate_bootstrap_cache()

    # Broadcast the canonical login transition so the UI can paint LOGGED_IN
    # immediately. ``set_login_status`` is the single funnel for login state.
    from flow_sdk.cloud_client.auth_state import set_login_status
    from flow_sdk.cloud_client.auth_status import HubLoginStatus

    await set_login_status(HubLoginStatus.LOGGED_IN, user=user_info)

    try:
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        await hub_ws_manager.restart()
    except Exception:
        pass

    # Restarting the WS only opens the pipe for FUTURE frames — the hub fans out
    # live and never replays, so anything addressed to this account while we were
    # logged out (or logged in as someone else) is still missing locally. Pull the
    # backlog now, exactly as startup does, so the Inbox is correct the moment the
    # user lands instead of after they find the manual refresh button.
    from flow_sdk.inbox.catchup import start_hub_catchup

    start_hub_catchup("login")


async def _broadcast_oauth(msg: OAuthMessage) -> None:
    try:
        from flow_sdk.server.routes.websocket import broadcast

        await broadcast(msg.model_dump_json())
    except Exception:
        pass


async def _broadcast_oauth_error(message: str) -> None:
    await _broadcast_oauth(
        OAuthMessage(
            oauth_request_id=OAuthProvider.FLOWPAD_CLOUD,
            status=OAuthMessageStatus.ERROR,
            message=message,
        )
    )
    # Mirror the failure into the canonical login-status channel so UI code
    # that has migrated to the new event no longer has to listen to OAuth.
    from flow_sdk.cloud_client.auth_state import set_login_status
    from flow_sdk.cloud_client.auth_status import HubLoginStatus

    await set_login_status(HubLoginStatus.LOGIN_FAILED, reason=message)


async def clear_cloud_credentials(reason: str | None = None) -> None:
    """Stop the hub WS, clear keyring + user JSON, broadcast LOGGED_OUT + DISCONNECTED.

    Single owner used by ``/api/v1/cloud/logout``, ``/api/v1/cloud/logout_callback``,
    the legacy ``flowpad_cloud/disconnect`` action handler, and
    ``invalidate_hub_login`` (which forwards a non-empty reason).
    """
    from flow_sdk.cli.auth.credentials import clear_credentials
    from flow_sdk.cloud_client.auth_state import set_connection_status, set_login_status
    from flow_sdk.cloud_client.auth_status import HubConnectionStatus, HubLoginStatus
    from flow_sdk.server import state
    from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache

    try:
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        # Signal only — this can run inside the WS task tree; see request_stop.
        hub_ws_manager.request_stop()
    except Exception:
        pass

    # Ordering is load-bearing: clear_credentials() resolves the active user
    # from the config.json pointer to delete that user's SCOPED sod entries,
    # so it must run BEFORE set_user({}) wipes the pointer. Do not reorder.
    clear_credentials()
    set_user({})
    state.login_result = None
    state.login_received.clear()
    invalidate_bootstrap_cache()

    await set_login_status(HubLoginStatus.LOGGED_OUT, reason=reason)
    await set_connection_status(HubConnectionStatus.DISCONNECTED)
