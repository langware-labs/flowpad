"""Cloud auth routes — single owner under ``/api/v1/cloud/*``.

* ``GET    /status``           — logged-in flag, current user, cloud URL
* ``POST   /login``            — env-mode (synchronous) or browser-mode
                                 (returns "started" + URL, completion via WS)
* ``POST   /logout``           — clear keyring + user JSON; return cloud logout URL
* ``GET    /logout_callback``  — cloud's redirect target after logout

The browser-mode login callback lives at ``/auth/login_callback`` — see
``flow_sdk/server/routes/auth.py``.
"""

import functools
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, JSONResponse

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter(prefix="/api/v1/cloud")

# Standardized copy for the privacy-mode block — kept in sync with the
# frontend guard (``ts_sdk/src/services/privacy-guard.ts``).
LOCAL_MODE_LOGIN_MESSAGE = "Login disabled in Local mode"


@router.get("/wiki/{wiki_ref}/resolve")
async def resolve_hub_wiki_route(
    wiki_ref: str,
    word: str = Query(..., min_length=1),
):
    """Resolve a Hub Wiki through the desktop's authenticated cloud transport.

    The Hub call itself uses the canonical
    ``/api/v1/graph/wiki/<wiki-ref>/resolve`` API.  This local route is the
    single-origin bridge used by the browser and also warms the local read cache
    for the resolved Wiki target.
    """

    from flow_sdk.cloud_client.wiki_cache import HubWikiCacheError, resolve_hub_wiki
    from flow_sdk.request_context.methods import get_current_request_info

    request_info = get_current_request_info()
    owner = request_info.user if request_info is not None else None
    try:
        result = await resolve_hub_wiki(wiki_ref, word, owner=owner)
    except HubWikiCacheError as exc:
        return JSONResponse(
            content=ApiFailResponse(message=str(exc)).model_dump(mode="json"),
            status_code=502,
        )
    return ApiSuccessResponse(data=result)


def _local_mode_login_block():
    """Return a 403 ApiFailResponse when this instance is in Local privacy mode,
    else ``None``. The single gate the cloud-auth routes call before any cloud
    side effect."""
    from flow_sdk.instance_settings.privacy_mode import is_local_mode

    if is_local_mode():
        return JSONResponse(
            content=ApiFailResponse(message=LOCAL_MODE_LOGIN_MESSAGE).model_dump(mode="json"),
            status_code=403,
        )
    return None


# ---------------------------------------------------------------------------
# Branded result page (login/logout success or error in the system browser)
# ---------------------------------------------------------------------------


def _render_result_page(
    title: str,
    heading: str,
    subheading: str,
    detail_html: str,
    color: str,
    icon: str,
    status_code: int = 200,
) -> HTMLResponse:
    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title} - Flowpad</title>
    <style>
        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
            max-width: 600px;
            margin: 50px auto;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
        }}
        .container {{
            background: white;
            border-radius: 12px;
            padding: 40px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            text-align: center;
        }}
        .result-icon {{ font-size: 64px; margin-bottom: 20px; }}
        h1 {{ color: {color}; margin-bottom: 10px; }}
        p {{ color: #666; margin: 10px 0; }}
        .detail-box {{
            background: color-mix(in srgb, {color} 8%, white);
            border-left: 4px solid {color};
            padding: 15px;
            margin: 20px 0;
            text-align: left;
            border-radius: 4px;
        }}
        .close-message {{
            background: #f8fafc;
            border: 2px solid #e2e8f0;
            border-radius: 8px;
            padding: 24px;
            margin-top: 40px;
            font-size: 18px;
            font-weight: 600;
            color: #334155;
        }}
    </style>
</head>
<body>
    <div class="container">
        <div class="result-icon">{icon}</div>
        <h1>{heading}</h1>
        <p>{subheading}</p>
        {detail_html}
    </div>
    <div class="close-message">
        ✓ You can now close this browser page
    </div>
</body>
</html>"""
    return HTMLResponse(content=html_content, status_code=status_code)


@router.get("/logout_callback", response_class=HTMLResponse)
async def logout_callback():
    """Cloud-redirect logout callback. Clears local credentials."""
    from flow_sdk.cli.auth.cloud_login import clear_cloud_credentials
    await clear_cloud_credentials()
    blank_script = '<script>setTimeout(function(){ document.body.innerHTML = ""; }, 10000);</script>'
    return _render_result_page(
        title="Logout Successful",
        heading="Logout Successful",
        subheading="You have been successfully logged out of Flowpad.",
        detail_html=blank_script,
        color="#22c55e",
        icon="👋",
    )


# ---------------------------------------------------------------------------
# JSON API
# ---------------------------------------------------------------------------


@router.get("/status")
async def status():
    """Logged-in flag, current user, cloud URL, and orthogonal hub statuses."""
    try:
        from flow_sdk.cloud_client import ApiConfig
        from flow_sdk.cloud_client.auth_state import login_block
        from flow_sdk.cloud_client.auth_status import HubLoginStatus
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        cloud_config = ApiConfig.from_env()
        cloud_url = cloud_config.api_base_url

        # Shared with the graph bootstrap, which now carries the same block so the
        # UI knows who it is at first paint instead of one round trip later. Two
        # copies of "who am I" is what let those two surfaces disagree.
        login = login_block()
        logged_in = login["status"] == HubLoginStatus.LOGGED_IN.value

        connection_payload = hub_ws_manager.connection_payload()

        return ApiSuccessResponse(data={
            # New nested shape — canonical, drives the UI.
            "login": login,
            "connection": connection_payload,
            "cloud_url": cloud_url,
            "cloud_app_url": cloud_config.app_base_url,
            # Deprecated aliases — kept for one release while UI migrates.
            "logged_in": logged_in,
            "user": login["user"],
            **hub_ws_manager.status_payload(),
        })
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


def _cloud_ws_error(message: str, status_code: int = 400):
    from flow_sdk.cloud_client.ws_client import hub_ws_manager

    return JSONResponse(
        content=ApiFailResponse(
            message=message,
            data={
                "connection": hub_ws_manager.connection_payload(),
                **hub_ws_manager.status_payload(),
            },
        ).model_dump(mode="json"),
        status_code=status_code,
    )


def cloud_route(fn):
    """Map the hub WebSocket error family onto the standard failure envelope.

    Every /cloud/ws/* route shared the same four-clause tail: login-required and
    auth errors are 401, a verification mismatch is 409, anything else is 500.
    Bodies keep their own pre-flight guards and any error-specific side effect
    (see connect_ws, which stops the manager before re-raising).
    """

    @functools.wraps(fn)
    async def _wrapped(*args, **kwargs):
        from flow_sdk.cloud_client.ws_client import (  # noqa: PLC0415
            HubWebSocketAuthError,
            HubWebSocketLoginRequiredError,
            HubWebSocketVerificationError,
        )

        try:
            return await fn(*args, **kwargs)
        except (HubWebSocketLoginRequiredError, HubWebSocketAuthError) as e:
            return _cloud_ws_error(str(e), 401)
        except HubWebSocketVerificationError as e:
            return _cloud_ws_error(str(e), 409)
        except Exception as e:  # noqa: BLE001
            return _cloud_ws_error(str(e), 500)

    return _wrapped


@router.post("/ws/connect")
@cloud_route
async def connect_ws():
    """Verify hub WS auth and start the background hub WebSocket listener."""
    blocked = _local_mode_login_block()
    if blocked is not None:
        return blocked
    from flow_sdk.cli.auth.hub_login import is_logged_in
    from flow_sdk.cloud_client.ws_client import (
        HubWebSocketVerificationError,
        hub_ws_manager,
    )

    if not is_logged_in():
        return _cloud_ws_error("Cloud login required before connecting hub WebSocket.", 401)

    status_payload = await hub_ws_manager.restart(wait_connected=True)
    if not status_payload.get("hub_ws_connected"):
        return _cloud_ws_error(status_payload.get("hub_ws_error") or "Hub WebSocket did not connect.", 502)

    try:
        verification = await hub_ws_manager.verify_current_user()
    except HubWebSocketVerificationError:
        # A credential mismatch must not leave a live listener behind; the 409
        # itself is mapped by @cloud_route.
        try:
            await hub_ws_manager.stop()
        except Exception:
            pass
        raise
    return ApiSuccessResponse(data={
        "connection": hub_ws_manager.connection_payload(),
        **hub_ws_manager.status_payload(),
        "verification": verification,
    })


@router.post("/ws/disconnect")
@cloud_route
async def disconnect_ws():
    """Stop the hub WebSocket listener without logging out."""
    from flow_sdk.cloud_client.ws_client import hub_ws_manager

    legacy = await hub_ws_manager.stop()
    return ApiSuccessResponse(data={
        "connection": hub_ws_manager.connection_payload(),
        **legacy,
    })


@router.post("/ws/verify")
@cloud_route
async def verify_ws():
    """Verify the current hub WebSocket credentials against the local cloud profile."""
    blocked = _local_mode_login_block()
    if blocked is not None:
        return blocked
    from flow_sdk.cli.auth.hub_login import is_logged_in
    from flow_sdk.cloud_client.ws_client import hub_ws_manager

    if not is_logged_in():
        return _cloud_ws_error("Cloud login required before verifying hub WebSocket.", 401)

    verification = await hub_ws_manager.verify_current_user()
    return ApiSuccessResponse(data={
        "connection": hub_ws_manager.connection_payload(),
        **hub_ws_manager.status_payload(),
        "verification": verification,
    })


@router.post("/login")
async def login():
    """Start a cloud login. ``cloud_login()`` decides env-mode vs browser-mode.

    Returns immediately with launch status:
      * ``{status: "logged_in", user: ...}`` — env-mode succeeded.
      * ``{status: "started", url: ...}``    — browser opened, watch WS for the result.

    On synchronous failure (rejected creds, can't open browser) returns a 400
    ``ApiFailResponse``.
    """
    blocked = _local_mode_login_block()
    if blocked is not None:
        return blocked
    from flow_sdk.cli.auth.cloud_login import cloud_login

    try:
        result = await cloud_login()
    except Exception as e:
        return JSONResponse(
            content=ApiFailResponse(message=str(e)).model_dump(mode="json"),
            status_code=400,
        )
    return ApiSuccessResponse(data=result)


@router.post("/logout")
async def logout():
    """Clear local credentials and return the cloud logout URL.

    The UI is expected to navigate the user to the returned URL (or open it in
    the system browser) so the cloud-side session is also invalidated.
    """
    from flow_sdk.cli.auth.cloud_login import clear_cloud_credentials
    from flow_sdk.cli.auth.cloud_urls import get_logout_url
    from flow_sdk.instance_settings import get_instance_settings

    await clear_cloud_credentials()
    port = get_instance_settings().port
    callback_url = f"http://127.0.0.1:{port}/api/v1/cloud/logout_callback"
    return ApiSuccessResponse(data={"cloud_logout_url": get_logout_url(callback_url)})


@router.get("/test_login", response_class=HTMLResponse)
async def test_login():
    """Serve the test login HTML page (dev fixture for ``flow auth test``)."""
    server_dir = Path(__file__).parent.parent
    html_file = server_dir / "test_login.html"
    with open(html_file, "r") as f:
        return HTMLResponse(content=f.read())
