"""Cloud auth routes — single owner under ``/api/v1/cloud/*``.

* ``GET    /status``           — logged-in flag, current user, cloud URL
* ``POST   /login``            — env-mode (synchronous) or browser-mode
                                 (returns "started" + URL, completion via WS)
* ``POST   /logout``           — clear keyring + user JSON; return cloud logout URL
* ``GET    /logout_callback``  — cloud's redirect target after logout

The browser-mode login callback lives at ``/auth/login_callback`` — see
``flow_sdk/server/routes/auth.py``.
"""

from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, JSONResponse

from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

router = APIRouter(prefix="/api/v1/cloud")


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
    clear_cloud_credentials()
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
    """Logged-in flag, current user, cloud URL (for tooltips)."""
    try:
        from flow_sdk.cli.app_config import get_user
        from flow_sdk.cli.auth.hub_login import is_logged_in
        from flow_sdk.cloud_client import ApiConfig
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        logged_in = is_logged_in()
        user_info = get_user() if logged_in else None
        cloud_url = ApiConfig.from_env().api_base_url

        return ApiSuccessResponse(data={
            "logged_in": logged_in,
            "user": user_info,
            "cloud_url": cloud_url,
            **hub_ws_manager.status_payload(),
        })
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)


def _cloud_ws_error(message: str, status_code: int = 400):
    from flow_sdk.cloud_client.ws_client import hub_ws_manager

    return JSONResponse(
        content=ApiFailResponse(
            message=message,
            data=hub_ws_manager.status_payload(),
        ).model_dump(mode="json"),
        status_code=status_code,
    )


@router.post("/ws/connect")
async def connect_ws():
    """Verify hub WS auth and start the background hub WebSocket listener."""
    try:
        from flow_sdk.cli.auth.hub_login import is_logged_in
        from flow_sdk.cloud_client.ws_client import (
            HubWebSocketAuthError,
            HubWebSocketLoginRequiredError,
            HubWebSocketVerificationError,
            hub_ws_manager,
        )

        if not is_logged_in():
            return _cloud_ws_error("Cloud login required before connecting hub WebSocket.", 401)

        status_payload = await hub_ws_manager.restart(wait_connected=True)
        if not status_payload.get("hub_ws_connected"):
            return _cloud_ws_error(status_payload.get("hub_ws_error") or "Hub WebSocket did not connect.", 502)

        verification = await hub_ws_manager.verify_current_user()
        return ApiSuccessResponse(data={**hub_ws_manager.status_payload(), "verification": verification})
    except HubWebSocketLoginRequiredError as e:
        return _cloud_ws_error(str(e), 401)
    except HubWebSocketAuthError as e:
        return _cloud_ws_error(str(e), 401)
    except HubWebSocketVerificationError as e:
        try:
            from flow_sdk.cloud_client.ws_client import hub_ws_manager

            await hub_ws_manager.stop()
        except Exception:
            pass
        return _cloud_ws_error(str(e), 409)
    except Exception as e:
        return _cloud_ws_error(str(e), 500)


@router.post("/ws/disconnect")
async def disconnect_ws():
    """Stop the hub WebSocket listener without logging out."""
    try:
        from flow_sdk.cloud_client.ws_client import hub_ws_manager

        return ApiSuccessResponse(data=await hub_ws_manager.stop())
    except Exception as e:
        return _cloud_ws_error(str(e), 500)


@router.post("/ws/verify")
async def verify_ws():
    """Verify the current hub WebSocket credentials against the local cloud profile."""
    try:
        from flow_sdk.cli.auth.hub_login import is_logged_in
        from flow_sdk.cloud_client.ws_client import (
            HubWebSocketAuthError,
            HubWebSocketLoginRequiredError,
            HubWebSocketVerificationError,
            hub_ws_manager,
        )

        if not is_logged_in():
            return _cloud_ws_error("Cloud login required before verifying hub WebSocket.", 401)

        verification = await hub_ws_manager.verify_current_user()
        return ApiSuccessResponse(data={**hub_ws_manager.status_payload(), "verification": verification})
    except HubWebSocketLoginRequiredError as e:
        return _cloud_ws_error(str(e), 401)
    except HubWebSocketAuthError as e:
        return _cloud_ws_error(str(e), 401)
    except HubWebSocketVerificationError as e:
        return _cloud_ws_error(str(e), 409)
    except Exception as e:
        return _cloud_ws_error(str(e), 500)


@router.post("/login")
async def login():
    """Start a cloud login. ``cloud_login()`` decides env-mode vs browser-mode.

    Returns immediately with launch status:
      * ``{status: "logged_in", user: ...}`` — env-mode succeeded.
      * ``{status: "started", url: ...}``    — browser opened, watch WS for the result.

    On synchronous failure (rejected creds, can't open browser) returns a 400
    ``ApiFailResponse``.
    """
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

    clear_cloud_credentials()
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
