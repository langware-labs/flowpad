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


@router.get("/oauth/complete", response_class=HTMLResponse)
async def oauth_complete(state: str = Query(""), provider: str = Query("")):
    """Where the hub returns the browser after it stored a grant — the default flow's end.

    Stores this instance's copy and tells the initiator (``complete_hub_flow``), then
    renders the one landing: close-only when the initiator was told, the full
    confirmation when nobody is left to tell. Never a 500 — a person is looking at it.
    """
    from flow_sdk.app.actions.oauth_action import complete_hub_flow
    from flow_sdk.app.actions.oauth_templates import landing_page
    from flow_sdk.cloud_client.shared.errors import HubError
    from flow_sdk.core.oauth import flows

    flow = flows.get_flow(state) if state else None
    provider = flow.provider if flow is not None else provider
    if not state or not provider:
        return landing_page(None, delivered=False)

    failure: flows.AuthFlowResult | None = None
    try:
        result, delivered = await complete_hub_flow(provider, state)
        if result is None:
            failure = flows.AuthFlowResult(
                status=flows.AuthFlowStatus.ERROR,
                provider=provider,
                code="not_finished",
                detail="The provider has not finished authorizing. Start the connection again.",
            )
    except HubError as exc:
        failure = flows.AuthFlowResult(
            status=flows.AuthFlowStatus.ERROR, provider=provider, code=exc.code or "hub_error", detail=exc.reason
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("oauth_complete: could not complete %s", provider)
        failure = flows.AuthFlowResult(
            status=flows.AuthFlowStatus.ERROR, provider=provider, code="completion_failed", detail=str(exc)
        )
    if failure is not None:
        # Tell the initiator it failed rather than leaving its screen waiting.
        result, delivered = failure, await flows.finish_flow(state, failure)
    return landing_page(result, delivered=delivered)


@router.get("/oauth/callback", response_class=HTMLResponse)
async def oauth_loopback_callback(state: str = Query(""), code: str = Query(""), error: str = Query("")):
    """Where a grant this instance runs itself lands — the loopback listener forwards here.

    Exchanges the code once, tells the initiator, and renders the one landing page.
    """
    from flow_sdk.app.actions.desktop_oauth import complete_loopback_flow
    from flow_sdk.app.actions.oauth_templates import landing_page

    result, delivered = await complete_loopback_flow(state, code, error)
    return landing_page(result, delivered=delivered)


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

        # A shared sandbox has exactly one logged-in identity for the whole
        # instance. If this login resolves to a DIFFERENT person than the one
        # currently signed in, drop the outgoing person's session and their
        # hub-mirrored data (conversations/messages/org membership) BEFORE
        # finalizing the new login — otherwise the incoming person inherits
        # the previous one's stream inbox. Checked strictly after the api-key
        # validates, for the same reason cookie-gate/runtime are: an
        # unvalidated caller must not be able to trigger a logout.
        from flow_sdk.cli.app_config import get_user

        current_user = get_user()
        incoming_id = user_info.get("id") if isinstance(user_info, dict) else None
        if current_user and incoming_id and current_user.get("id") != incoming_id:
            from flow_sdk.cli.auth.cloud_login import clear_user_data
            from flow_sdk.cloud_client.auth_status import LogoutReason

            logger.info(
                "login_callback: switching logged-in user (%s -> %s), clearing previous session",
                current_user.get("id"),
                incoming_id,
            )
            await clear_user_data(reason=LogoutReason.SWITCHED_OUT)

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


@router.get("/oauth_callback", response_class=HTMLResponse)
async def oauth_callback(state: str = "", code: str = "", error: str = ""):
    """Redeem a sandbox sign-in code only against its server-held PKCE state."""
    from flow_sdk.app.actions.desktop_oauth import _desktop_oauth_sessions, complete_loopback_flow
    from flow_sdk.app.actions.oauth_templates import landing_page
    from flow_sdk.cli.auth.cloud_login import _broadcast_oauth_error
    from flow_sdk.cli.auth.sandbox_login import complete_sandbox_login

    if _desktop_oauth_sessions.get(state) is not None:
        # A provider grant redirected to this sandbox's public URL: the same one
        # completion and landing as a desktop loopback grant.
        result, delivered = await complete_loopback_flow(state, code, error)
        return landing_page(result, delivered=delivered)
    try:
        if error:
            raise ValueError("Sign-in was not authorized")
        await complete_sandbox_login(state, code)
    except Exception:
        await _broadcast_oauth_error("Sandbox sign-in failed. Start sign-in again.")
        return HTMLResponse("Sandbox sign-in failed. Return to Flowpad and try again.", status_code=400)
    return HTMLResponse(
        "<p>Signed in. You can close this window.</p><script>window.close()</script>",
        headers={"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"},
    )
