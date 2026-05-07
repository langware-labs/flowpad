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

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from .. import state
from .cloud import _render_result_page

router = APIRouter(prefix="/auth")


@router.get("/login_callback", response_class=HTMLResponse)
async def login_callback(
    flowpad_api_key: str = Query(None, alias="flowpad-api-key"),
    next: str = Query(None),
):
    """Cloud-redirect callback. Validates the api-key and finalizes the login.

    `next` (same-origin path only) lets deep-link flows redirect back into the
    SPA after a successful login.
    """
    try:
        from flow_sdk.cli.auth.cloud_login import _finalize_login
        from flow_sdk.cli.auth.hub_login import validate_api_key_async
        from flow_sdk.cloud_client.api.auth import LoginData

        if not flowpad_api_key:
            raise ValueError("No API key provided. Expected 'flowpad-api-key' parameter.")

        user_info = await validate_api_key_async(flowpad_api_key)
        await _finalize_login(LoginData(
            token=flowpad_api_key,
            expires=None,
            refresh_token=None,
            user=user_info,
        ))

        if next and next.startswith("/"):
            return RedirectResponse(url=next, status_code=302)

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
        from flow_sdk.cli.auth.cloud_login import _broadcast_oauth_error

        state.login_result = {"success": False, "error": str(e), "message": "Login failed"}
        state.login_received.set()
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
