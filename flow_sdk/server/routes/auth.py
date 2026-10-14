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
from urllib.parse import urlencode, urlsplit

from fastapi import APIRouter, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from flow_sdk.cli.auth.secrets import is_secrets_enabled
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.server.grants import safe_next

from .. import state
from .cloud import _render_result_page

router = APIRouter(prefix="/auth")

logger = logging.getLogger(__name__)


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
async def gate(request: Request, ticket: str = Query(None), next: str = Query(None)):
    """Trade the hub's ticket for this box's grant cookie, or this machine's token for
    its local cookie, then redirect.

    The browser's one cold request at the system door. It cannot already hold the
    grant: the hub admitted it (``service_endpoint/<id>/open``) and sent it here with a
    ticket — the grant subject signed with this box's gate secret, good for a minute.
    The box verifies it with the secret it already holds and keeps the same subject as a
    cookie signed with a key of its own (``server/grants.py``). The secret itself is in
    neither; the redirect leaves a clean URL bar.

    Not a path exemption — ``CookieGateMiddleware`` gates this route like every
    other, and it is reachable precisely *because* the caller presented the ticket.

    On this machine (a loopback host) it is the local gate's door instead: the
    ``?cookie-gate=`` token sets the local cookie. ``next`` may be an absolute ``http(s)``
    URL only when that token is in the URL: the backend opens the hub login and OAuth
    authorize pages through here (``cloud_urls.wrap_url_auth_gate``), so the return to
    this host carries the cookie. A link without the token in its URL still reaches this
    route -- a click from a desktop app passes the gate's direct-open rule, and a click
    from a web page carries the browser's ``Lax`` cookie -- so its ``next`` is held to
    this instance (``safe_next``); otherwise any link would be an open redirect.

    On an unarmed instance this is inert — it redirects without setting anything,
    so a stale link still lands in the app rather than 404ing.
    """
    from flow_sdk.instance_settings import cookie_gate
    from flow_sdk.server import grants
    from flow_sdk.server.service_proxy import SYSTEM_AUDIENCE
    from flow_sdk.utils.networking import is_loopback

    if is_loopback(request.url.hostname):
        response = RedirectResponse(url=_gate_next(next, cookie_gate.verify_query_param(request)), status_code=302)
        if cookie_gate.verify_cookie(request):
            header = cookie_gate.set_cookie_header(request)
            if header:
                response.headers.append("set-cookie", header)
        return response

    landing = safe_next(next)
    traded = grants.exchange(ticket, audience=SYSTEM_AUDIENCE, landing=landing)
    # No ticket for this door: the middleware already admitted the caller some other way, so land them.
    return traded or RedirectResponse(url=landing, status_code=302, headers={"Cache-Control": "no-store"})


@router.post("/revoke")
async def revoke(request: Request):
    """``POST /auth/revoke {"caller": <typeid or null>, "endpoints": [<id>, …]}`` — the hub closing doors.

    Someone's standing narrowed on the hub (a member removed, a role lowered, a stamp
    withdrawn, a placement deleted); their grants on these endpoints are refused from now
    until they would have expired anyway. ``caller`` null means everyone's, the visitor's
    included. Only the hub's hop may say so: the request must carry the gate SECRET as the
    machine header — a browser's grant cookie, which also passes the middleware, is not
    enough to revoke anybody.
    """
    from flow_sdk.instance_settings.cookie_gate import get_cookie_gate
    from flow_sdk.responses.response import ApiSuccessResponse
    from flow_sdk.server import grants
    from flow_sdk.server.middleware.cookie_gate_middleware import HEADER_NAME
    from flow_sdk.server.service_serving import fail

    secret = get_cookie_gate()
    presented = request.headers.get(HEADER_NAME) or ""
    if not secret or not compare_digest(presented, secret):
        return fail(403, "the hub's hop only")
    body = await request.json()
    caller = body.get("caller") if isinstance(body, dict) else None
    endpoints = body.get("endpoints") if isinstance(body, dict) else None
    if not isinstance(endpoints, list) or not all(isinstance(e, str) and e for e in endpoints):
        return fail(400, "endpoints: a list of ids")
    count = grants.revoke(str(caller) if caller else None, endpoints)
    return JSONResponse(status_code=200, content=ApiSuccessResponse(data={"revoked": count}).model_dump(mode="json"))


def _gate_next(candidate: str | None, linked_with_token: bool) -> str:
    """An absolute ``http(s)`` URL as given when the link carried the token in its URL,
    else a same-origin path (``safe_next``)."""
    parts = urlsplit(candidate or "")
    if linked_with_token and parts.scheme in ("http", "https") and parts.netloc:
        return candidate
    return safe_next(candidate)


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
        # instance — see `purge_outgoing_user_if_switching` for the shared
        # switch-detection this and the sandbox-reclaim path both run.
        # Checked strictly after the api-key validates, for the same reason
        # cookie-gate/runtime are: an unvalidated caller must not be able to
        # trigger a logout.
        from flow_sdk.cli.auth.cloud_login import purge_outgoing_user_if_switching

        await purge_outgoing_user_if_switching(user_info, caller="login_callback")

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
            from flow_sdk.instance_settings.cookie_gate import DesktopGateRefused, set_cookie

            try:
                set_cookie(cookie_gate)
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

        # A link that asked to land somewhere lands in the app: on its path, or on home when
        # that path is refused. The page below is for a sign-in that named nowhere to go.
        if next:
            return RedirectResponse(url=safe_next(next), status_code=302)

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
