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
    cancel_github_device_flow,
    delete_anthropic_token_for_current_user,
    get_desktop_oauth_auth_url,
    get_anthropic_token_for_current_user,
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

        # Cancel — explicit teardown for device-flow sessions (used by UI Cancel button).
        if oauth_action_str == "cancel":
            state = request_info.request_parameters.get("state") if request_info.request_parameters else None
            if not state:
                return ApiFailResponse(message="State parameter required for cancel")
            cancelled = cancel_github_device_flow(state) if provider == "github" else False
            return ApiSuccessResponse(data={"cancelled": cancelled})

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
            if provider == "github":
                return await _handle_github_disconnect()
            if provider == "anthropic":
                return await delete_anthropic_token_for_current_user()
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

    Desktop mode reads Flowpad-owned SOD entries. It never inspects Claude Code's
    credential store.
    """
    try:
        if provider == "anthropic":
            credentials, error = await get_anthropic_token_for_current_user()
            if error is not None:
                return ApiSuccessResponse(
                    message="Connection status checked",
                    data={
                        "status": "error",
                        "has_token": False,
                        "is_attached": False,
                        "auth_method": "anthropic",
                        "error": error,
                    },
                )
            return ApiSuccessResponse(
                message="Connection status checked",
                data={
                    "status": "available" if credentials else "missing",
                    "has_token": bool(credentials),
                    "is_attached": bool(credentials),
                    "auth_method": "anthropic",
                },
            )

        if provider == "github":
            token, error = await _get_github_token_for_current_user()
            if error is not None:
                # SOD driver outage / FK ValueError / DB error — distinct from "no token".
                return ApiSuccessResponse(
                    message="Connection status checked",
                    data={
                        "status": "error",
                        "has_token": False,
                        "is_attached": False,
                        "auth_method": "github",
                        "error": error,
                    },
                )
            return ApiSuccessResponse(
                message="Connection status checked",
                data={
                    "status": "available" if token else "missing",
                    "has_token": bool(token),
                    "is_attached": bool(token),
                    "auth_method": "github",
                },
            )

        # Default: no credentials available
        return ApiSuccessResponse(
            message="Connection status checked",
            data={
                "status": "missing",
                "has_token": False,
                "is_attached": False,
                "auth_method": "none",
            },
        )
    except Exception as e:
        # Unexpected error path (above branches handle their own errors). Surface
        # status="error" so the UI can distinguish from a genuine "no credential".
        logger.warning(f"OAuth status check error for {provider}: {e}")
        return ApiSuccessResponse(
            message="Connection status checked",
            data={
                "status": "error",
                "has_token": False,
                "is_attached": False,
                "auth_method": provider if provider in {"anthropic", "github"} else "none",
                "error": str(e),
            },
        )


async def _handle_flowpad_cloud_disconnect() -> ApiResponse:
    """Handle flowpad_cloud disconnect: clear local credentials and return the cloud logout URL."""
    from flow_sdk.cli.auth.cloud_login import clear_cloud_credentials
    from flow_sdk.cli.auth.cloud_urls import get_logout_url
    from flow_sdk.instance_settings import get_instance_settings

    await clear_cloud_credentials()

    port = get_instance_settings().port
    post_logout_url = f"http://127.0.0.1:{port}/api/v1/cloud/logout_callback"
    cloud_logout_url = get_logout_url(post_logout_url)
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
    from flow_sdk.cli.auth.cloud_urls import get_login_url
    from flow_sdk.instance_settings import get_instance_settings

    settings = get_instance_settings()
    callback_path = "/auth/login_callback"
    if settings.docker_public_url:
        callback_url = f"{settings.docker_public_url}{callback_path}"
    else:
        callback_url = f"http://127.0.0.1:{settings.port}{callback_path}"

    return ApiSuccessResponse(
        data=OauthClientRequestInfo(
            provider=OAuthProvider.FLOWPAD_CLOUD,
            auth_url=get_login_url(callback_url),
            # Fixed ID — must match the oauth_request_id broadcast by _finalize_login
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


async def _get_github_token_for_current_user() -> tuple[str | None, str | None]:
    """Look up the current request's user and return ``(token, error)``.

    Returns ``(token, None)`` on success (token may be None if no SOD entry).
    Returns ``(None, error_str)`` when something went wrong — so callers can
    distinguish a genuine 'no credential' from an infrastructure failure."""
    try:
        from flow_sdk.builtin.user import User
        from flow_sdk.request_context.methods import get_user_credentials

        request_info = get_current_request_info()
        if not request_info or not getattr(request_info, "user", None):
            return None, None  # no request user → treat as missing (not an error)
        user = await User.get_by_typeid(request_info.user)
        if not user:
            return None, None
        # Same FK convention as the write side in _save_github_token_to_sod.
        try:
            token = await get_user_credentials(user, "github_credentials", user.id)
            return token, None
        except KeyError:
            # Standard "no SOD entry" — distinct from infrastructure errors below.
            return None, None
    except Exception as e:
        logger.warning(f"github token lookup failed: {e}")
        return None, str(e)


async def _handle_github_disconnect() -> ApiResponse:
    """Delete the user's github_credentials SOD entry."""
    try:
        from flow_sdk.builtin.user import User
        from flow_sdk.request_context.methods import delete_user_credentials

        request_info = get_current_request_info()
        if not request_info or not getattr(request_info, "user", None):
            return ApiFailResponse(message="No request user")
        user = await User.get_by_typeid(request_info.user)
        if not user:
            return ApiFailResponse(message="User not found")
        await delete_user_credentials(user, "github_credentials", user.id)
        return ApiSuccessResponse(
            message="GitHub disconnected",
            data={"remaining_attachment_count": 0},
        )
    except Exception as e:
        logger.exception(f"GitHub disconnect error: {e}")
        return ApiFailResponse(message=f"GitHub disconnect error: {e}")
