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
from urllib.parse import urlencode

from fastapi import APIRouter, Query
from fastapi.responses import HTMLResponse, RedirectResponse

from flow_sdk.cli.auth.secrets import is_secrets_enabled
from flow_sdk.instance_settings import get_instance_settings

from .. import state
from .cloud import _render_result_page

router = APIRouter(prefix="/auth")

logger = logging.getLogger(__name__)


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

        secrets_enabled = is_secrets_enabled()
        logger.info(
            "login_callback: secrets_enabled=%s has_key=%s next=%r",
            secrets_enabled,
            bool(flowpad_api_key),
            next,
        )

        if not flowpad_api_key:
            raise ValueError("No API key provided. Expected 'flowpad-api-key' parameter.")

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
            qs = urlencode({"flowpad-api-key": flowpad_api_key, "next": next or ""})
            return RedirectResponse(url=f"/electron/keychain-approval?{qs}", status_code=302)

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
