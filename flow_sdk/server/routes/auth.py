"""Top-level auth callback routes — mounted at ``/auth/*``.

* ``GET /auth/login_callback`` — cloud's redirect target after browser-mode auth.
                                  Path is referenced verbatim by the hub's
                                  ``append_desktop_api_key`` (hub:
                                  ``core/auth/providers/auth_provider.py``); both
                                  the local-CLI login flow and the staging
                                  landing-page "open in flowpad" deep-link land
                                  here.

The handler validates the api-key, finalizes the login, and either redirects to
``next`` (same-origin path only) or renders the success page.
"""

import logging
import os
from secrets import compare_digest
from urllib.parse import urlencode

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from flow_sdk.cli.auth.secrets import is_secrets_enabled
from flow_sdk.instance_settings import get_instance_settings

from .. import state
from .cloud import _render_result_page

router = APIRouter(prefix="/auth")

logger = logging.getLogger(__name__)


def _safe_next(candidate: str | None, default: str = "/") -> str:
    """A same-origin redirect target, or ``default``.

    ``startswith("/")`` alone is not enough: ``//evil.com`` is a protocol-relative
    URL, which a browser follows straight off the origin. Anything that is not a
    single-slash absolute path is refused.
    """
    if not candidate or not candidate.startswith("/") or candidate.startswith("//"):
        return default
    return candidate


@router.get("/gate")
async def gate(
    cookie_gate: str = Query(None, alias="cookie-gate"),
    next: str = Query(None),
):
    """Trade the cookie-gate secret for the httpOnly cookie, then redirect.

    The browser's one cold request. It cannot already hold the cookie: the
    callback that armed this instance was curl'd over sandbox loopback, so that
    Set-Cookie went to curl. The hub therefore points the browser here, secret in
    hand, and the redirect leaves a clean URL bar.

    Not a path exemption — ``CookieGateMiddleware`` gates this route like every
    other, and it is reachable precisely *because* the caller presented the
    secret. Being a route rather than a branch in the middleware is what lets the
    caller state its intent instead of having it guessed from headers: the hub's
    curl wants ``login_callback`` and gets it, the browser wants a cookie and
    asks here.

    On an unarmed instance this is inert — it redirects without setting anything,
    so a stale gate link still lands in the app rather than 404ing.
    """
    from flow_sdk.instance_settings.cookie_gate import get_cookie_gate
    from flow_sdk.server.middleware.cookie_gate_middleware import COOKIE_NAME

    response = RedirectResponse(url=_safe_next(next), status_code=302)

    secret = get_cookie_gate()
    if secret is not None and cookie_gate and compare_digest(cookie_gate, secret):
        response.set_cookie(
            COOKIE_NAME,
            secret,
            path="/",
            secure=True,
            httponly=True,
            samesite="lax",
        )
    return response


@router.get("/login_callback", response_class=HTMLResponse)
async def login_callback(
    flowpad_api_key: str = Query(None, alias="flowpad-api-key"),
    next: str = Query(None),
    cookie_gate: str = Query(None, alias="cookie-gate"),
    runtime: str = Query(None),
    oauth_request_id: str = Query(None),
):
    """Cloud-redirect callback. Validates the api-key and finalizes the login.

    `next` (same-origin path only) lets deep-link flows redirect back into the
    SPA after a successful login.

    `cookie-gate` arms this instance's request gate (see
    ``flow_sdk/instance_settings/cookie_gate.py``). The hub passes it here
    because this request is made by curl over sandbox loopback — a channel the
    sandbox's public URL cannot see. Optional: absent, nothing changes.

    `runtime` records what the hub launched this instance AS — ``sandbox`` for a
    box a human opened, ``agent`` for one an agent Identity was deployed into.
    It rides this request for the same reason ``cookie-gate`` does, and because
    this is the hub's ONLY guaranteed channel into a running box: the app
    restart that could carry it as env is skipped in production, where the
    sandbox keeps serving from its template snapshot. Optional and, like
    ``cookie-gate``, applied strictly after the api-key validates.
    """
    try:
        from flow_sdk.cli.auth.cloud_login import _finalize_login
        from flow_sdk.cli.auth.hub_login import validate_api_key_async
        from flow_sdk.cloud_client.api.auth import LoginData

        secrets_enabled = is_secrets_enabled()
        logger.info(
            "login_callback: secrets_enabled=%s has_key=%s next=%r",
            secrets_enabled,
            bool(flowpad_api_key),
            next,
        )

        if not flowpad_api_key:
            raise ValueError(
                "No API key provided. Expected 'flowpad-api-key' parameter. Restart Flowpad and upgrade your version."
            )

        # Pre-flight the OS-keychain approval ONLY under signed Electron
        # (FLOWPAD_DESKTOP=1, set by electron/uv-manager.js::start()). Only
        # there does the /electron/keychain-approval SPA route make sense:
        # it triggers the dialog whose handleApprove calls electronAPI
        # provisionSodKey → IPC → bundled flow-rs binary → SecItemAdd, so the
        # keychain entry's ACL trust list shows flow-rs (Langware-signed)
        # rather than the unsigned uv-bundled python3.x. In web/CLI mode
        # there is no Electron, no IPC, and no signed binary to own the
        # write — we fall through to _finalize_login and accept the raw
        # system prompt attributed to python3.x as the CLI/web posture.
        if not secrets_enabled and os.environ.get("FLOWPAD_DESKTOP") == "1":
            qs = urlencode(
                {
                    "flowpad-api-key": flowpad_api_key,
                    "next": next or "",
                    "oauth_request_id": oauth_request_id or "",
                }
            )
            return RedirectResponse(url=f"/electron/keychain-approval?{qs}", status_code=302)

        user_info = await validate_api_key_async(flowpad_api_key)
        await _finalize_login(
            LoginData(
                token=flowpad_api_key,
                expires=None,
                refresh_token=None,
                user=user_info,
            )
        )
        if oauth_request_id:
            state.finish_cloud_login_session(oauth_request_id, success=True)

        # Arm strictly AFTER the api-key validates. Arming on an unvalidated
        # request would let an anonymous caller lock the instance with a secret
        # only they hold.
        if cookie_gate:
            from flow_sdk.instance_settings.cookie_gate import DesktopGateRefused, set_cookie_gate

            try:
                set_cookie_gate(cookie_gate)
                logger.info("login_callback: cookie-gate armed for this instance")
            except DesktopGateRefused as e:
                # Same posture as an unassignable runtime below: a login must not
                # fail over this. Arming here would lock the desktop app out of
                # its own health check, so dropping the secret is the outcome
                # that leaves a working app.
                logger.warning("login_callback: %s", e)

        # Same gate, same reason: an unvalidated caller must not be able to
        # relabel the instance. An unassignable or unknown value is logged and
        # dropped — a login must not fail over a display label.
        if runtime:
            from flow_sdk.instance_settings.runtime import set_assigned_runtime

            try:
                logger.info("login_callback: runtime assigned as %s", set_assigned_runtime(runtime))
            except ValueError:
                logger.warning("login_callback: ignoring unassignable runtime %r", runtime)

        safe_next = _safe_next(next, default="")
        if safe_next:
            return RedirectResponse(url=safe_next, status_code=302)

        user_id = user_info.get("id", "Unknown")
        s = get_instance_settings()
        detail_html = (
            f'<div class="detail-box">'
            f"<strong>Account Details:</strong><br>User ID: {user_id}<br>"
            f"<strong>Encrypted credentials:</strong><br>"
            f"sodot=<code>{s.sodot_path}</code><br>"
            f"keychain key=<code>Flowpad.ai.sod_key / {s.instance_name}</code>"
            f"</div>"
        )
        return _render_result_page(
            title="Login Successful",
            heading="Login Successful!",
            subheading="You have been successfully logged in to Flowpad.",
            detail_html=detail_html,
            color="#22c55e",
            icon="✓",
        )
    except Exception as e:
        from flow_sdk.cli.auth.cloud_login import _broadcast_oauth_error

        state.login_result = {"success": False, "error": str(e), "message": "Login failed"}
        state.login_received.set()
        if oauth_request_id:
            state.finish_cloud_login_session(oauth_request_id, success=False, detail=str(e))
        await _broadcast_oauth_error(str(e))

        detail_html = f'<div class="detail-box"><strong>Error Details:</strong><br>{e}</div>'
        return _render_result_page(
            title="Login Failed",
            heading="Login Failed",
            subheading="There was an error during login.",
            detail_html=detail_html,
            color="#ef4444",
            icon="✗",
            status_code=400,
        )
