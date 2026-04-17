"""OAuth action handler for flow-cli.

Ported from FlowPad: flowpad/hub/app/actions/oauth/oauth_action.py
Desktop mode: registers the @action.all("oauth") action path for API
compatibility. Dispatches to desktop OAuth sub-actions.

Routes:
  GET/POST /api/v1/graph/oauth/{provider}/{sub_action}
"""

import logging

from flow_sdk.core import action
from flow_sdk.api.oauth_api import OAuthAction, OAuthErrorCode, OAuthProvider, OauthClientRequestInfo
from flow_sdk.app.actions.desktop_oauth import (
    _desktop_oauth_sessions,
    get_desktop_oauth_auth_url,
    handle_desktop_oauth_callback,
    wait_for_desktop_oauth_callback,
)
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _parse_oauth_info(request_info):
    """Parse OAuth provider and action from request sub_path.

    sub_path format: {provider}/{action}
    e.g., "anthropic/auth", "github/status", "anthropic/callback"
    """
    sub_path = request_info.sub_path
    if not sub_path:
        return None, None

    parts = sub_path.strip("/").split("/")
    if len(parts) < 2:
        return parts[0] if parts else None, None

    provider = parts[0]
    oauth_action = parts[1]
    return provider, oauth_action


@action.all(action_name="oauth")
async def oauth_main() -> ApiResponse:
    """Main OAuth action dispatcher.

    Ported from FlowPad: flowpad/hub/app/actions/oauth/oauth_action.py
    Desktop mode handles:
    - auth: Generate authorization URL (desktop PKCE flow)
    - callback: Handle OAuth callback
    - wait-callback: Long-poll for desktop OAuth callback
    - attach: Attach OAuth credentials to entity
    - detach: Detach OAuth credentials from entity
    - status: Check OAuth connection status
    - disconnect: Remove OAuth credentials entirely
    """
    try:
        request_info = get_current_request_info()
        if not request_info:
            return ApiFailResponse(message="No request context available")

        provider, oauth_action_str = _parse_oauth_info(request_info)

        if not provider:
            return ApiFailResponse(message="OAuth provider name is required in sub_path")
        if not oauth_action_str:
            return ApiFailResponse(message="OAuth action is required in sub_path")

        logger.info(f"OAuth action: provider={provider}, action={oauth_action_str}")

        # Status check - always works, returns desktop status
        if oauth_action_str == OAuthAction.Status:
            return await _handle_status(provider)

        # Auth - generate authorization URL
        if oauth_action_str == OAuthAction.Auth:
            return await _handle_auth(provider, request_info)

        # Callback - handle OAuth callback
        if oauth_action_str == OAuthAction.Callback:
            return await _handle_callback(provider, request_info)

        # Wait-callback - long-poll for desktop OAuth callback
        if oauth_action_str == OAuthAction.WaitCallback:
            state = request_info.request_parameters.get("state") if request_info.request_parameters else None
            if not state:
                return ApiFailResponse(message="State parameter required for wait-callback")
            return await _handle_wait_callback(provider, state)

        # Attach
        if oauth_action_str == OAuthAction.Attach:
            return ApiSuccessResponse(message=f"OAuth {provider} attached (desktop stub)")

        # Detach
        if oauth_action_str == OAuthAction.Detach:
            return ApiSuccessResponse(
                message=f"OAuth {provider} detached (desktop stub)",
                data={"remaining_attachment_count": 0},
            )

        # Disconnect
        if oauth_action_str == OAuthAction.Disconnect:
            if provider == OAuthProvider.FLOWPAD_CLOUD:
                return await _handle_flowpad_cloud_disconnect()
            return ApiSuccessResponse(
                message=f"OAuth {provider} disconnected (desktop stub)",
                data={"remaining_attachment_count": 0},
            )

        return ApiFailResponse(message=f"OAuth action not supported: {oauth_action_str}")

    except Exception as e:
        logger.exception(f"OAuth error: {e}")
        return ApiFailResponse(message=f"OAuth error: {str(e)}")


async def _handle_status(provider: str) -> ApiResponse:
    """Check OAuth connection status for a provider.

    Desktop mode: checks if Anthropic auth is available via detect_claude_code_auth.
    For other providers, returns MISSING status.
    """
    try:
        if provider == "anthropic":
            try:
                from flow_sdk.builtin.faas.claude_code_auth import detect_claude_code_auth
                auth_status = await detect_claude_code_auth()
                return ApiSuccessResponse(
                    message="Connection status checked",
                    data={
                        "status": "available" if auth_status.is_authenticated else "missing",
                        "has_token": auth_status.is_authenticated,
                        "is_attached": auth_status.is_authenticated,
                        "auth_method": auth_status.auth_method.value if hasattr(auth_status, 'auth_method') else "none",
                    },
                )
            except ImportError:
                pass

        # Default: no credentials available
        return ApiSuccessResponse(
            message="Connection status checked",
            data={
                "status": "missing",
                "has_token": False,
                "is_attached": False,
            },
        )
    except Exception as e:
        logger.warning(f"OAuth status check error for {provider}: {e}")
        return ApiSuccessResponse(
            message="Connection status checked",
            data={"status": "missing", "has_token": False, "is_attached": False},
        )


async def _handle_flowpad_cloud_disconnect() -> ApiResponse:
    """Handle flowpad_cloud disconnect: clear local credentials and return the cloud logout URL."""
    import os

    from flow_sdk.cli.app_config import set_user
    from flow_sdk.cli.auth import delete_api_key
    from flow_sdk.cli.env_loader import get_logout_url
    from flow_sdk.server.routes.bootstrap import invalidate_bootstrap_cache
    from flow_sdk.server import state as server_state

    port = int(os.environ.get("LOCAL_SERVER_PORT", "9007"))
    post_logout_url = f"http://127.0.0.1:{port}/post_logout"
    cloud_logout_url = get_logout_url(post_logout_url)

    delete_api_key()
    set_user({})
    server_state.login_result = None
    server_state.login_received.clear()
    invalidate_bootstrap_cache()

    return ApiSuccessResponse(data={"remaining_attachment_count": 0, "browser_url": cloud_logout_url})


async def _handle_auth(provider: str, request_info) -> ApiResponse:
    """Generate OAuth authorization URL.

    Desktop mode: generates desktop OAuth auth URL with PKCE and localhost callback.
    For flowpad_cloud: returns the cloud login URL with a fresh oauth_request_id.
    """
    if provider == OAuthProvider.FLOWPAD_CLOUD:
        return await _get_flowpad_cloud_oauth_auth()

    # Extract user_id from request context
    user_id = ""
    if request_info and hasattr(request_info, 'target_entity_id') and request_info.target_entity_id:
        user_id = request_info.target_entity_id
    elif request_info and hasattr(request_info, 'user') and request_info.user:
        user_id = request_info.user.id if hasattr(request_info.user, 'id') else str(request_info.user)

    return await get_desktop_oauth_auth_url(provider, user_id)


async def _get_flowpad_cloud_oauth_auth() -> ApiResponse:
    """Generate Flowpad cloud login URL."""
    import os

    from flow_sdk.cli.env_loader import get_login_url

    port = int(os.environ.get("LOCAL_SERVER_PORT", "9007"))
    public_url = os.environ.get("FLOWPAD_DOCKER_PUBLIC_URL", "").strip()
    callback_url = f"{public_url}/post_login" if public_url else f"http://127.0.0.1:{port}/post_login"

    auth_url = get_login_url(callback_url)

    return ApiSuccessResponse(
        data=OauthClientRequestInfo(
            provider=OAuthProvider.FLOWPAD_CLOUD,
            auth_url=auth_url,
            # Fixed ID — must match the oauth_request_id broadcast by /post_login
            oauth_request_id=OAuthProvider.FLOWPAD_CLOUD,
        )
    )


async def _handle_callback(provider: str, request_info) -> ApiResponse:
    """Handle OAuth callback with authorization code.

    Desktop mode: if this is a desktop session (state matches), exchanges code for token.
    This serves as an alternative callback path if the redirect goes through the API
    instead of the localhost callback server.
    """
    code = request_info.request_parameters.get("code") if request_info.request_parameters else None
    state = request_info.request_parameters.get("state") if request_info.request_parameters else None

    if not code:
        return ApiFailResponse(message="Missing authorization code")

    # If we have code and state, and it's a desktop session, handle it
    if code and state and state in _desktop_oauth_sessions:
        return await handle_desktop_oauth_callback(code, state)

    return ApiFailResponse(
        message=f"OAuth callback for {provider}: session not found. "
        "The callback may have been received by the localhost server already."
    )


async def _handle_wait_callback(provider: str, state: str) -> ApiResponse:
    """Wait for desktop OAuth callback via long-polling.

    Desktop mode: waits for localhost callback server to receive the code,
    then exchanges it for a token and saves credentials.
    """
    return await wait_for_desktop_oauth_callback(state)
