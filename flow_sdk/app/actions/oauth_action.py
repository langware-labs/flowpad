"""OAuth action handler for flow-cli.

Ported from FlowPad: flowpad/hub/app/actions/oauth/oauth_action.py
Desktop mode: registers the @action.all("oauth") action path for API
compatibility. Dispatches to desktop OAuth sub-actions.

Routes:
  GET/POST /api/v1/graph/oauth/{provider}/{sub_action}
"""

import logging

from flow_sdk.api.oauth_api import OAuthAction, OauthClientRequestInfo, OAuthProvider
from flow_sdk.app.actions.desktop_oauth import (
    _desktop_oauth_sessions,
    cancel_github_device_flow,
    delete_anthropic_token_for_current_user,
    get_anthropic_token_for_current_user,
    get_desktop_oauth_auth_url,
    handle_desktop_oauth_callback,
    wait_for_desktop_oauth_callback,
)
from flow_sdk.app.actions.oauth_attachment import attach_action, detach_action, disconnect_action
from flow_sdk.core import action
from flow_sdk.core.oauth import resolve_user_credentials_name, unresolved_provider_reason
from flow_sdk.core.oauth.hub_oauth import (
    hub_credential_value,
    hub_credentials_name_for,
    hub_start_auth,
    poll_hub_credential,
    redirect_unreachable_reason,
)
from flow_sdk.core.oauth.provider_registry import OAuthFlowKind, get_local_provider, prefers_hub_flow
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


def _attachment_response(result) -> ApiResponse:
    """One shape for every attach/detach/disconnect outcome, carrying the error
    code so the client can branch on it rather than on prose."""
    if not result.success:
        return ApiFailResponse(message=result.message, data={"error": result.error})
    return ApiSuccessResponse(
        message=result.message,
        data={"remaining_attachment_count": result.remaining_attachment_count},
    )


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

        # Test — prove the stored token still works, by calling the provider.
        if oauth_action_str == "test":
            return await _handle_test(provider)

        # Cancel — explicit teardown for device-flow sessions (used by UI Cancel button).
        if oauth_action_str == "cancel":
            state = request_info.request_parameters.get("state") if request_info.request_parameters else None
            if not state:
                return ApiFailResponse(message="State parameter required for cancel")
            cancelled = cancel_github_device_flow(state) if provider == "github" else False
            return ApiSuccessResponse(data={"cancelled": cancelled})

        # Attach — grants the target entity use of the user's credential and
        # mints the reference row on the target. Two-sided; see oauth_attachment.
        if oauth_action_str == OAuthAction.Attach:
            shared_var = (
                request_info.request_parameters.get("shared_entity_var_name")
                if request_info.request_parameters
                else None
            )
            result = await attach_action(provider, shared_var)
            return _attachment_response(result)

        # Detach — cleans both sides and reports the REAL remaining count. The
        # stub always said 0, which made the client chain into disconnect and
        # destroy the user's token on every project detach.
        if oauth_action_str == OAuthAction.Detach:
            return _attachment_response(await detach_action(provider))

        # Disconnect
        if oauth_action_str == OAuthAction.Disconnect:
            if provider == OAuthProvider.FLOWPAD_CLOUD:
                return await _handle_flowpad_cloud_disconnect()
            if provider == "github":
                return await _handle_github_disconnect()
            if provider == "anthropic":
                return await delete_anthropic_token_for_current_user()
            return _attachment_response(await disconnect_action(provider))

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
    if request_info and hasattr(request_info, "target_entity_id") and request_info.target_entity_id:
        user_id = request_info.target_entity_id
    elif request_info and hasattr(request_info, "user") and request_info.user:
        user_id = request_info.user.id if hasattr(request_info.user, "id") else str(request_info.user)

    local = get_local_provider(provider)

    # Explicit escape hatch: ``auth?flow=device`` runs the LOCAL grant even when
    # the hub could carry the code flow. Exists for the case where the hub
    # completes the flow but refuses to release the token value (see
    # ``_handle_wait_callback``'s hub_release_failed) — the local grant is then
    # the only one that actually lands a usable credential.
    requested_flow = (request_info.request_parameters or {}).get("flow") if request_info else None
    if requested_flow == "device":
        if local is None:
            return ApiFailResponse(message=f"Provider {provider} has no local flow")
        logger.info("OAuth: %s local flow explicitly requested; skipping the hub", provider)
        return await get_desktop_oauth_auth_url(provider, user_id)

    # A real authorization-code grant wins. The only local flow that is NOT one
    # is GitHub's device grant — it makes the user retype a code and is bounded
    # by what a device-flow app is registered for — so when the hub can run the
    # code flow for a provider, that is the flow we use. Anthropic's loopback IS
    # a code grant (code + PKCE, redirected to a port on this machine), so it
    # stays local and never needs the hub.
    hub_refusal: str | None = None
    if prefers_hub_flow(provider):
        hub_payload = await hub_start_auth(provider)
        if hub_payload:
            # Preflight the callback host BEFORE handing the browser a doomed
            # consent screen. Signing in successfully and then landing nowhere is
            # indistinguishable from "nothing happened" to the person clicking —
            # which is exactly how a stale tunnel URL hid for as long as it did.
            hub_refusal = await redirect_unreachable_reason(str(hub_payload.get("auth_url") or ""))
            if not hub_refusal:
                logger.info("OAuth: %s runs the authorization-code flow on the hub", provider)
                # Name the grant, so the client knows where it completes.
                # ``CODE`` already means exactly this one — "authorization code,
                # redirect handled by the hub" — while ``LOOPBACK`` is the same
                # grant redirected to a port on THIS machine. The two finish in
                # completely different places and only the loopback one posts its
                # result back here, so a payload that says neither is a payload
                # the client has to guess about: it guessed loopback, waited for
                # a local callback that could never arrive, and left the token
                # sitting on the hub with the connection reading MISSING. A
                # ``code`` flow tells the client to drive ``wait-callback``,
                # which polls the hub and adopts the token into local SOD.
                return ApiSuccessResponse(data={**hub_payload, "kind": OAuthFlowKind.CODE.value})

        # The hub cannot carry this flow — unreachable, or its callback host is
        # not serving. Either way it is "hub unavailable": a provider with a
        # local grant falls through to it below (a device code beats no
        # connection), and one without gets the reason rather than the desktop
        # path's "not supported", which would point at the wrong thing.
        logger.info("OAuth: hub cannot run %s (%s)", provider, hub_refusal or "unreachable")
        if hub_refusal and local is None:
            return ApiFailResponse(message=hub_refusal)

    return await get_desktop_oauth_auth_url(provider, user_id)


async def _get_flowpad_cloud_oauth_auth() -> ApiResponse:
    """Generate Flowpad cloud login URL."""
    from flow_sdk.cli.auth.cloud_urls import desktop_login_callback_url, get_login_url

    return ApiSuccessResponse(
        data=OauthClientRequestInfo(
            provider=OAuthProvider.FLOWPAD_CLOUD,
            auth_url=get_login_url(desktop_login_callback_url()),
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
    """Wait for the OAuth flow to finish.

    Desktop grants: the localhost callback server receives the code, exchanges it
    and saves the credential — ``state`` identifies that session.

    Hub grants: the hub receives the callback, and its completion message goes
    out on the hub's websocket, which this process is not on. So we poll the
    hub's own env table until the token lands, then make it usable here.
    """
    if state in _desktop_oauth_sessions:
        return await wait_for_desktop_oauth_callback(state)

    local_name = await resolve_user_credentials_name(provider)
    hub_name = hub_credentials_name_for(provider)
    if not await poll_hub_credential(hub_name):
        # Not an error: the user may still be at the provider. The client keeps
        # its popup open and the hub keeps the session.
        return ApiSuccessResponse(data={"status": "polling"})

    adopted = await _adopt_hub_credential(provider, local_name or hub_name, hub_name)
    if not adopted:
        # The hub confirmed the token row but refused to release its value, so
        # nothing landed in local SOD. Reporting success here would leave the
        # Connections tab saying Connected while every local consumer (git
        # push, gh, asset publish) keeps failing — the exact lie this guards.
        return ApiFailResponse(
            message=(
                f"The hub holds the {provider} token but did not release its value; "
                f"reconnect with the local device flow (auth?flow=device)"
            ),
            data={"status": "hub_release_failed", "provider": provider},
        )
    return ApiSuccessResponse(data={"status": "success", "provider": provider})


async def _adopt_hub_credential(provider: str, local_name: str, hub_name: str) -> bool:
    """Make a hub-held token usable on this machine.

    Two different needs, so two behaviours:

    * A provider with LOCAL consumers of the raw token — GitHub, whose token is
      read out of local SOD by ``git push``, the ``gh`` capability and the repo
      actions — gets the value copied into local SOD under the local name.
      Without this the Connections tab would say Connected while every one of
      those kept failing.
    * A provider with no local consumer — Slack — gets a value-free row only.
      The token stays on the hub and is resolved when a worker actually needs it,
      which is the rule the rest of the secret plane follows.

    Returns False only in the lie case: a provider with local consumers whose
    value the hub refused to release. Row-only providers return True.
    """
    from flow_sdk.app.actions.desktop_oauth import record_credential  # noqa: PLC0415
    from flow_sdk.core.entity.entity_env.env_types import EnvVar, EnvVarType  # noqa: PLC0415
    from flow_sdk.core.oauth.hub_providers import invalidate_hub_providers  # noqa: PLC0415
    from flow_sdk.core.oauth.provider_registry import get_local_provider  # noqa: PLC0415
    from flow_sdk.request_context.methods import get_current_request_user_fresh  # noqa: PLC0415

    invalidate_hub_providers()

    user = await get_current_request_user_fresh()
    if user is None:
        return False

    adopted = True
    if get_local_provider(provider) is not None:
        value = await hub_credential_value(hub_name)
        if value:
            # Through the same seam the desktop grants use, so an adopted token
            # and a locally-granted one are indistinguishable afterwards.
            await record_credential(user, provider, value)
            logger.info("OAuth: adopted the hub's %s token into local %s", provider, local_name)
        else:
            logger.warning("OAuth: hub holds %s but would not release its value", hub_name)
            adopted = False

    # A provider the hub owns outright has no local value to record, but the row
    # still has to exist or the table reads it as MISSING.
    if user.get_env_var(local_name) is None:
        user.set_env_var(
            EnvVar(
                name=local_name,
                description=f"OAuth token for {provider}",
                var_type=EnvVarType.OAUTH_TOKEN,
                ref_name=local_name,
            )
        )
        await user.update()
    return adopted


async def _handle_test(provider: str) -> ApiResponse:
    """Call the provider with the stored token and report what came back.

    Answers the question the Connected badge cannot: the row says a token exists
    and a project may use it, which stays true after the token is revoked at the
    provider. Only a real call can tell the difference.

    The token is looked for where it actually lives — local SOD first, then the
    hub for providers whose token it holds — so the same button works whichever
    side ran the flow.
    """
    from flow_sdk.core.oauth.provider_probe import (  # noqa: PLC0415
        identity_from_credential,
        run_probe,
        token_from_credential,
    )
    from flow_sdk.request_context.methods import (  # noqa: PLC0415
        get_current_request_user_fresh,
        get_user_credentials,
    )

    cred_name = await resolve_user_credentials_name(provider)
    if not cred_name:
        return ApiFailResponse(message=unresolved_provider_reason(provider))

    user = await get_current_request_user_fresh()
    if user is None:
        return ApiFailResponse(message="No user in request context")

    stored: object = None
    try:
        stored = await get_user_credentials(user, cred_name, user.id)
    except Exception as e:  # noqa: BLE001
        logger.debug("OAuth test: no local credential for %s: %s", cred_name, e)

    token = token_from_credential(stored)
    if not token and prefers_hub_flow(provider):
        # Only the hub can be holding it. A local-only provider (Anthropic's
        # loopback) has nothing there, so asking would be a wasted round-trip.
        stored = await hub_credential_value(hub_credentials_name_for(provider))
        token = token_from_credential(stored)

    result = await run_probe(provider, token or "")
    # A provider whose probe cannot name the holder may still have shipped one in
    # the credential itself (Anthropic stores the account email).
    if result.ok and not result.identity:
        result.identity = identity_from_credential(stored)
    logger.info("OAuth test: %s -> ok=%s (%s)", provider, result.ok, result.detail or result.identity)
    # Always a SUCCESS envelope: "the token is dead" is a successful test, and a
    # FAIL envelope would make the client show a transport error instead.
    return ApiSuccessResponse(data=result.as_data())


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
        # Same FK convention as the write side in record_credential — and the
        # same NAME source, so a rename cannot leave the write and read halves
        # pointing at different SOD entries.
        try:
            token = await get_user_credentials(user, _github_credentials_name(), user.id)
            return token, None
        except KeyError:
            # Standard "no SOD entry" — distinct from infrastructure errors below.
            return None, None
    except Exception as e:
        logger.warning(f"github token lookup failed: {e}")
        return None, str(e)


def _github_credentials_name() -> str:
    """The SOD entry GitHub's token lives in, from the registry.

    The fallback keeps a de-registered provider readable rather than turning a
    lookup into a crash — the same shape `flow_source_control` uses.
    """
    from flow_sdk.core.oauth.provider_registry import GITHUB, user_credentials_name  # noqa: PLC0415

    return user_credentials_name(GITHUB) or "github_credentials"


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
        name = _github_credentials_name()
        await delete_user_credentials(user, name, user.id)
        # Drop the visibility row too, or the provider keeps reading CONNECTED.
        from flow_sdk.app.actions.desktop_oauth import _drop_credential_row  # noqa: PLC0415

        await _drop_credential_row(user, name)
        from flow_sdk.builtin.capability import restamp_capability_state
        from flow_sdk.core.capabilities import CapabilityKind

        await restamp_capability_state(CapabilityKind.GITHUB.value)
        return ApiSuccessResponse(
            message="GitHub disconnected",
            data={"remaining_attachment_count": 0},
        )
    except Exception as e:
        logger.exception(f"GitHub disconnect error: {e}")
        return ApiFailResponse(message=f"GitHub disconnect error: {e}")
