"""
Authentication routes for the local server.
"""

from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

from flow_sdk.api.messages import OAuthMessage, OAuthMessageStatus
from flow_sdk.api.oauth_api import OAuthProvider
from flow_sdk.responses.response import ApiSuccessResponse

from .. import state

router = APIRouter()  # page routes — mounted at root
api_router = APIRouter(prefix="/api/v1/auth")  # API routes — mounted under /api/v1


def _render_result_page(
    title: str,
    heading: str,
    subheading: str,
    detail_html: str,
    color: str,
    icon: str,
    status_code: int = 200,
) -> HTMLResponse:
    """Render a simple branded result page (login/logout success or error)."""
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
        .result-icon {{
            font-size: 64px;
            margin-bottom: 20px;
        }}
        h1 {{
            color: {color};
            margin-bottom: 10px;
        }}
        p {{
            color: #666;
            margin: 10px 0;
        }}
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


@router.get("/post_login", response_class=HTMLResponse)
async def post_login(
    flowpad_api_key: str = Query(None, alias="flowpad-api-key"),
    next: str = Query(None),
):
    """
    POST login endpoint that receives an API key.
    Validates the API key and stores it in the system keyring.

    If `next` is provided, redirect there after success — used by deep-link
    flows (e.g. email "Open in FlowPad") so the same browser navigation that
    populates the keyring also lands the user on the target page. Only same-
    origin paths are honoured to prevent open-redirect abuse.
    """
    print(f"[post_login] called with key={'***' if flowpad_api_key else None} next={next!r}", flush=True)
    try:
        # Import here to avoid circular dependency
        from flow_sdk.cli.app_config import set_user
        from flow_sdk.cli.auth import set_api_key, validate_api_key

        if not flowpad_api_key:
            raise ValueError("No API key provided. Expected 'flowpad-api-key' parameter.")

        user_info = validate_api_key(flowpad_api_key)
        set_api_key(flowpad_api_key)
        set_user(user_info)

        state.login_result = {"success": True, "user": user_info, "message": "Login successful"}
        state.login_received.set()

        # Invalidate the bootstrap cache so the next fetch returns cloud_login_available=true
        from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache
        invalidate_bootstrap_cache()

        # Notify connected WebSocket clients
        try:
            import asyncio

            from flow_sdk.server.routes.websocket import broadcast

            msg = OAuthMessage(
                oauth_request_id=OAuthProvider.FLOWPAD_CLOUD,
                status=OAuthMessageStatus.SUCCESS,
            )
            asyncio.ensure_future(broadcast(msg.model_dump_json()))
        except Exception:
            pass

        # Same-origin redirect after successful login (deep-link flows).
        print(f"[post_login] checking redirect: next={next!r}", flush=True)
        if next and next.startswith("/"):
            print(f"[post_login] redirecting to {next}", flush=True)
            return RedirectResponse(url=next, status_code=302)
        print("[post_login] no redirect — falling through to success page", flush=True)

        user_id = user_info.get("id", "Unknown")
        detail_html = f'<div class="detail-box"><strong>Account Details:</strong><br>User ID: {user_id}</div>'
        return _render_result_page(
            title="Login Successful",
            heading="Login Successful!",
            subheading="You have been successfully logged in to Flowpad.",
            detail_html=detail_html,
            color="#22c55e",
            icon="✓",
        )

    except Exception as e:
        state.login_result = {"success": False, "error": str(e), "message": "Login failed"}
        state.login_received.set()

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


@router.get("/test_login", response_class=HTMLResponse)
async def test_login():
    """
    Serve the test login HTML page for testing authentication flow.

    Returns:
        HTML response with the test login page
    """
    # Get the path to the HTML file
    server_dir = Path(__file__).parent.parent
    html_file = server_dir / "test_login.html"

    # Read and return the HTML content
    with open(html_file, "r") as f:
        html_content = f.read()

    return HTMLResponse(content=html_content)


@api_router.get("/status")
async def auth_status():
    """Check if user is logged in."""
    try:
        from flow_sdk.cli.app_config import get_user
        from flow_sdk.cli.auth import is_logged_in

        logged_in = is_logged_in()
        user_info = get_user() if logged_in else None

        return ApiSuccessResponse(data={"logged_in": logged_in, "user": user_info})
    except Exception as e:
        return JSONResponse(content={"error": str(e)}, status_code=500)



def _clear_local_credentials():
    """Clear the locally stored API key and user info."""
    from flow_sdk.cli.app_config import set_user
    from flow_sdk.cli.auth import delete_api_key
    from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache

    delete_api_key()
    set_user({})
    state.login_result = None
    state.login_received.clear()
    invalidate_bootstrap_cache()


@router.get("/post_logout", response_class=HTMLResponse)
async def post_logout():
    """
    Callback after cloud logout. Clears local credentials and shows a confirmation page.
    The cloud server redirects here after invalidating the server-side session.
    """
    _clear_local_credentials()
    blank_script = '<script>setTimeout(function(){ document.body.innerHTML = ""; }, 10000);</script>'
    return _render_result_page(
        title="Logout Successful",
        heading="Logout Successful",
        subheading="You have been successfully logged out of Flowpad.",
        detail_html=blank_script,
        color="#22c55e",
        icon="👋",
    )



@api_router.post("/refresh-token")
async def refresh_token() -> ApiSuccessResponse[str]:
    """
    Refresh authentication token endpoint.

    For local development, this simply returns a success response with a dummy token.
    In a production environment, this would validate and refresh the JWT token.

    Returns:
        ApiSuccessResponse containing a token string
    """
    # Return a dummy token for local development
    dummy_token = "local_dev_token_refresh"
    return ApiSuccessResponse[str](data=dummy_token)
