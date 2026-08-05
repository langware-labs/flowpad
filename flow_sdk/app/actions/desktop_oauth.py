"""Desktop OAuth session management.

Ported from FlowPad: flowpad/hub/app/actions/oauth/desktop_oauth.py
Implements the full desktop PKCE OAuth flow with localhost callback server.

Flow:
1. get_desktop_oauth_auth_url() -> generates auth URL, starts localhost callback server
2. User opens auth URL in browser, authenticates
3. Provider redirects to localhost callback server
4. wait_for_desktop_oauth_callback() -> waits for callback, exchanges code for token
5. handle_desktop_oauth_callback() -> stores credentials, broadcasts WebSocket notification
"""

import asyncio
import base64
import hashlib
import json
import logging
import os
import secrets
import socket
import time
from typing import Any, Optional, Tuple
from urllib.parse import urlencode

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

from flow_sdk.api.messages import LlmConfigMessage, OAuthMessageStatus
from flow_sdk.app.actions.oauth_templates import OAUTH_ERROR_HTML, OAUTH_SUCCESS_HTML
from flow_sdk.core.oauth.provider_registry import (
    ANTHROPIC,
    LocalOAuthProvider,
    OAuthFlowKind,
    TokenShape,
    client_id_for,
    get_local_provider,
    user_credentials_name,
)
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

# OAuth callback timeout in seconds (2 minutes)
OAUTH_CALLBACK_TIMEOUT = 120

# Endpoints, scopes and client ids live in `provider_registry` — one descriptor
# per provider, so adding a third is a dict entry rather than a branch here. This
# module used to hold them as constants AND compare `provider` against the
# literals "github"/"anthropic", which is why a registered provider could still
# not start a flow.
ANTHROPIC_CREDENTIALS_NAME = user_credentials_name(ANTHROPIC) or "anthropic_credentials"


def _coerce_int(value: Any, default: int) -> int:
    """Defensive int() that tolerates None/non-numeric/missing — returns ``default`` on failure.

    Used for parsing optional numeric fields from third-party JSON (e.g. GitHub's
    device-flow response) where ``int(None)`` / ``int("abc")`` would otherwise
    escape as an unhandled exception."""
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        return default


# Cap for slow_down growth (RFC 8628 §3.5 mandates +5s per slow_down, no upper
# bound; we cap to keep the modal countdown from outracing the next poll).
DEVICE_POLL_INTERVAL_CAP_SECONDS = 30


class DesktopOAuthSession:
    """Manages desktop OAuth flow with localhost callback server.

    Ported from FlowPad: flowpad/hub/app/actions/oauth/desktop_oauth.py
    """

    def __init__(self, state: str, code_verifier: str, redirect_uri: str, user_id: str, provider: str = "anthropic"):
        self.state = state
        self.code_verifier = code_verifier
        self.redirect_uri = redirect_uri
        self.user_id = user_id
        self.provider = provider
        # Loopback flow fields (Anthropic)
        self.callback_code: Optional[str] = None
        self.callback_state: Optional[str] = None
        self.callback_error: Optional[str] = None
        self.callback_server: Optional[asyncio.Task] = None
        self.callback_port: Optional[int] = None
        self.callback_event: asyncio.Event = asyncio.Event()
        # Device flow fields (GitHub) — set only on the github branch
        self.device_code: Optional[str] = None
        self.user_code: Optional[str] = None
        self.verification_uri: Optional[str] = None
        self.expires_at_monotonic: Optional[float] = None  # time.monotonic() reference (clock-skew safe)
        self.poll_interval: int = 5  # seconds; bumped on slow_down, capped at DEVICE_POLL_INTERVAL_CAP_SECONDS
        # Set by /oauth/github/cancel — polling loop honors at its next iteration.
        self.cancel_event: Optional[asyncio.Event] = None
        # If save_to_sod fails after a successful authorization, the token is
        # retained here so it can be recovered without forcing the user back
        # through github.com. (Operator inspection / future /retry-save action.)
        self.pending_access_token: Optional[str] = None

    @staticmethod
    def _find_free_port() -> int:
        """Find a free port for the callback server."""
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(("", 0))
            s.listen(1)
            port = s.getsockname()[1]
        return port

    async def _start_callback_server(self, port: int, expected_state: str) -> None:
        """Start a temporary FastAPI server to receive OAuth callback."""
        app = FastAPI()

        @app.get("/callback")
        async def callback(request: Request):
            code = request.query_params.get("code")
            received_state = request.query_params.get("state")

            if code and received_state == expected_state:
                self.callback_code = code
                self.callback_state = received_state
                self.callback_event.set()
                return HTMLResponse(OAUTH_SUCCESS_HTML)
            else:
                error_msg = "State mismatch" if received_state != expected_state else "Missing authorization code"
                self.callback_error = error_msg
                self.callback_event.set()
                return HTMLResponse(OAUTH_ERROR_HTML, status_code=400)

        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
        server = uvicorn.Server(config)
        await server.serve()

    async def wait_for_callback(self, timeout: int = OAUTH_CALLBACK_TIMEOUT) -> Optional[Tuple[str, str]]:
        """Wait for OAuth callback to be received using asyncio Event."""
        try:
            await asyncio.wait_for(self.callback_event.wait(), timeout=timeout)

            if self.callback_error:
                error_msg = self.callback_error
                self.callback_error = None

                # Stop callback server
                if self.callback_server:
                    self.callback_server.cancel()
                    try:
                        await self.callback_server
                    except asyncio.CancelledError:
                        pass
                    self.callback_server = None

                # Send error notification via WebSocket
                try:
                    await _broadcast_llm_config_msg(
                        is_configured=False,
                        auth_method="none",
                        oauth_request_id=self.state,
                        status=OAuthMessageStatus.ERROR,
                    )
                except Exception as e:
                    logger.error(f"Failed to send WebSocket error notification: {e}")

                raise ValueError(f"OAuth callback error: {error_msg}")

            if self.callback_code and self.callback_state:
                code = self.callback_code
                state = self.callback_state
                self.callback_code = None
                self.callback_state = None

                # Stop callback server
                if self.callback_server:
                    self.callback_server.cancel()
                    try:
                        await self.callback_server
                    except asyncio.CancelledError:
                        pass
                    self.callback_server = None

                return (code, state)

            return None
        except asyncio.TimeoutError:
            # Timeout - stop callback server
            if self.callback_server:
                self.callback_server.cancel()
                try:
                    await self.callback_server
                except asyncio.CancelledError:
                    pass
                self.callback_server = None

            # Send timeout notification via WebSocket
            try:
                await _broadcast_llm_config_msg(
                    is_configured=False,
                    auth_method="none",
                    oauth_request_id=self.state,
                    status=OAuthMessageStatus.ERROR,
                )
            except Exception as e:
                logger.error(f"Failed to send WebSocket timeout notification: {e}")

            raise ValueError("OAuth callback timeout")


# Store active desktop OAuth sessions
_desktop_oauth_sessions: dict[str, DesktopOAuthSession] = {}


async def _broadcast_llm_config_msg(
    is_configured: bool,
    auth_method: str,
    oauth_request_id: Optional[str] = None,
    status: Optional[OAuthMessageStatus] = None,
    auth_data: Optional[dict] = None,
) -> None:
    """Broadcast LlmConfigMessage to all connected WebSocket clients."""
    try:
        from flow_sdk.server.routes.websocket import broadcast

        msg = LlmConfigMessage(
            is_configured=is_configured,
            auth_method=auth_method,
            auth_data=auth_data,
            oauth_request_id=oauth_request_id,
            status=status,
        )
        await broadcast(json.dumps(msg.model_dump(mode="json"), default=str))
    except ImportError:
        logger.warning("Could not import broadcast from minihub.routes.websocket")
    except Exception as e:
        logger.error(f"Failed to broadcast LlmConfigMessage: {e}")


async def _broadcast_oauth_msg(oauth_request_id: str, status: OAuthMessageStatus) -> None:
    """Announce that an OAuth FLOW ended, on the channel built for exactly that.

    ``LlmConfigMessage`` says "this user's LLM config changed" and grew
    ``oauth_request_id``/``status`` only because nobody was emitting this. The
    client's ``OAuthService.onOAuthMessage`` is the completion state machine —
    it closes the popup AND runs the auto-attach to the flow's target entity.
    Without this broadcast a desktop popup flow never reached it, so its token
    was stored and then never attached to the project that asked for it.
    """
    try:
        from flow_sdk.api.messages import OAuthMessage  # noqa: PLC0415
        from flow_sdk.server.routes.websocket import broadcast  # noqa: PLC0415

        msg = OAuthMessage(oauth_request_id=oauth_request_id, status=status)
        await broadcast(json.dumps(msg.model_dump(mode="json"), default=str))
    except Exception as e:  # noqa: BLE001
        logger.error(f"Failed to broadcast OAuthMessage: {e}")


def _build_authorize_url(
    provider: LocalOAuthProvider,
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str = "",
) -> str:
    """The authorization URL for a code/loopback grant.

    Uses ``urlencode`` rather than the hand-rolled encoder this replaced, which
    ``quote()``d exactly two params and then joined with ``&`` — correct for
    Anthropic's values by luck, and a silent corruption for any provider whose
    scope or redirect happened to need different escaping.

    PKCE params are sent only when the descriptor asks for them, and anything
    provider-peculiar (Anthropic's bare ``code=true``) comes from
    ``extra_authorize_params`` so it cannot leak to a provider that would reject it.
    """
    params = {
        "client_id": client_id,
        "scope": " ".join(provider.scopes),
        "state": state,
        "redirect_uri": redirect_uri,
        "response_type": "code",
    }
    if provider.pkce and code_challenge:
        params["code_challenge"] = code_challenge
        params["code_challenge_method"] = "S256"
    params.update(dict(provider.extra_authorize_params))
    return f"{provider.endpoints.authorize_url}?{urlencode(params)}"


async def get_desktop_oauth_auth_url(provider: str, user_id: str) -> ApiResponse:
    """Start a desktop OAuth flow for ``provider``, driven by its descriptor.

    Which grant runs comes from ``LocalOAuthProvider.kind``; where it goes comes
    from ``.endpoints``. A provider with no endpoints is one only the hub can
    run — it still has a Connections row and still routes to the hub, it just
    has no local flow. That replaces a comparison against the literal strings
    "github"/"anthropic", which meant a newly registered provider got a row in
    the UI and then failed here.
    """
    p = get_local_provider(provider)
    if p is None or p.endpoints is None:
        return ApiFailResponse(message=f"Desktop OAuth not supported for provider: {provider}")
    if p.kind is OAuthFlowKind.DEVICE:
        return await _start_device_flow(p, user_id)
    return await _start_loopback_flow(p, user_id)


async def _start_loopback_flow(provider: LocalOAuthProvider, user_id: str) -> ApiResponse:
    """Authorization code (+ PKCE when the descriptor asks) against a loopback port.

    The redirect target is a port on THIS machine, which is what makes it a real
    code grant without the provider needing to reach us.
    """
    client_id = client_id_for(provider.name)
    if not client_id:
        return ApiFailResponse(message=f"No client id configured for {provider.display_name}")

    code_verifier = ""
    code_challenge = ""
    if provider.pkce:
        code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("utf-8").rstrip("=")
        code_challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("utf-8")).digest())
            .decode("utf-8")
            .rstrip("=")
        )

    state = secrets.token_urlsafe(32)
    callback_port = DesktopOAuthSession._find_free_port()
    redirect_uri = f"http://localhost:{callback_port}/callback"

    session = DesktopOAuthSession(
        state=state,
        code_verifier=code_verifier,
        redirect_uri=redirect_uri,
        user_id=user_id,
        provider=provider.name,
    )
    session.callback_port = callback_port
    session.callback_server = asyncio.create_task(session._start_callback_server(callback_port, state))
    _desktop_oauth_sessions[state] = session

    auth_url = _build_authorize_url(provider, client_id, redirect_uri, state, code_challenge)
    logger.info("Desktop OAuth auth URL generated for %s, port=%s", provider.name, callback_port)

    return ApiSuccessResponse(
        data={"kind": "loopback", "url": auth_url, "port": callback_port, "state": state}
    )


async def _start_device_flow(provider: LocalOAuthProvider, user_id: str) -> ApiResponse:
    """Initiate an RFC 8628 device grant. No client_secret, no callback server.

    The vocabulary below (`authorization_pending`, `slow_down`, `expired_token`)
    is the RFC's, not GitHub's — which is why this stays one implementation
    rather than a per-provider branch.
    """
    import time

    client_id = client_id_for(provider.name)
    if not client_id or client_id.startswith("REPLACE_WITH_"):
        return ApiFailResponse(
            message=f"{provider.display_name} OAuth not configured. Register an OAuth App with "
            f"Device Flow enabled and set {provider.client_id_env}."
        )

    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                provider.endpoints.device_code_url,
                data={"client_id": client_id, "scope": " ".join(provider.scopes)},
                headers={"Accept": "application/json"},
                timeout=15.0,
            )
            if response.status_code != 200:
                return ApiFailResponse(
                    message=f"{provider.display_name} device-code request failed "
                    f"({response.status_code}): {response.text[:300]}"
                )
            body = response.json()
    except Exception as e:
        logger.warning("%s device-code request error: %s", provider.display_name, e)
        return ApiFailResponse(message=f"{provider.display_name} device-code request error: {e}")

    device_code = body.get("device_code")
    user_code = body.get("user_code")
    verification_uri = body.get("verification_uri") or body.get("verification_uri_complete")
    expires_in = _coerce_int(body.get("expires_in"), 900)
    interval = _coerce_int(body.get("interval"), 5)
    if not (device_code and user_code and verification_uri):
        return ApiFailResponse(
            message=f"{provider.display_name} returned unexpected device-code body: {body}"
        )

    state = secrets.token_urlsafe(32)
    session = DesktopOAuthSession(
        state=state,
        code_verifier="",  # n/a for device flow
        redirect_uri="",   # n/a for device flow
        user_id=user_id,
        provider=provider.name,
    )
    session.device_code = device_code
    session.user_code = user_code
    session.verification_uri = verification_uri
    session.expires_at_monotonic = time.monotonic() + expires_in
    session.poll_interval = interval
    session.cancel_event = asyncio.Event()
    _desktop_oauth_sessions[state] = session

    logger.info("%s device flow started for user %s, user_code=%s", provider.name, user_id, user_code)

    return ApiSuccessResponse(
        data={
            "kind": "device",
            "user_code": user_code,
            "verification_uri": verification_uri,
            "expires_in": expires_in,
            "interval": interval,
            "state": state,
        }
    )


async def _exchange_device_code(session: DesktopOAuthSession) -> dict:
    """One poll iteration. Returns {kind: 'pending'|'slow_down'|'denied'|'expired'|'success'|'error', ...}.

    Pure HTTP — caller decides what to do (loop / broadcast / save). All network
    failures are coerced to ``{kind: 'transient', message: ...}`` so the polling
    loop can decide whether to retry (transient) vs abort (error)."""
    provider = get_local_provider(session.provider)
    if provider is None or provider.endpoints is None:
        return {"kind": "error", "message": f"unknown provider: {session.provider}"}
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                provider.endpoints.token_url,
                data={
                    "client_id": client_id_for(provider.name),
                    "device_code": session.device_code,
                    "grant_type": provider.endpoints.device_grant,
                },
                headers={"Accept": "application/json"},
                timeout=15.0,
            )
    except Exception as e:
        # Network blip, DNS failure, timeout — keep the poll alive; caller retries.
        return {"kind": "transient", "message": f"{type(e).__name__}: {e}"}
    if response.status_code != 200:
        return {"kind": "error", "message": f"HTTP {response.status_code}: {response.text[:300]}"}
    try:
        body = response.json()
    except Exception as e:
        return {"kind": "error", "message": f"Malformed JSON from token endpoint: {e}"}
    err = body.get("error")
    if err == "authorization_pending":
        return {"kind": "pending"}
    if err == "slow_down":
        return {"kind": "slow_down"}
    if err == "expired_token":
        return {"kind": "expired"}
    if err == "access_denied":
        return {"kind": "denied"}
    if err:
        return {"kind": "error", "message": err}
    token = body.get("access_token")
    if not token:
        return {"kind": "error", "message": f"No access_token in success body: {body}"}
    return {"kind": "success", "access_token": token, "token_type": body.get("token_type"), "scope": body.get("scope")}


async def _resolve_auth_session_user(user_id: str):
    """Resolve the user an OAuth grant should bind to, or ``None``.

    Prefers the session-pinned ``user_id`` (the requester captured at /auth
    time) over any current request context so a long-poll that crosses request
    boundaries (re-signin, token rotation, different /wait-callback caller)
    can't bind the grant to the wrong account.

    Path B FIRST: the user captured when the device flow was initiated — the
    only resolution that's stable across the full poll window. Path A fallback:
    the current request's user, only when Path B fails outright (e.g. the
    original user was deleted) — accepts the rebinding risk only when the
    alternative is total token loss."""
    from flow_sdk.builtin.user import User
    from flow_sdk.request_context.methods import get_current_request_info

    if user_id:
        try:
            user = await User.get_by_id(user_id)
            if user:
                return user
        except Exception:
            pass
    request_info = get_current_request_info()
    if request_info and getattr(request_info, "user", None):
        try:
            return await User.get_by_typeid(request_info.user)
        except Exception:
            return None
    return None



async def _mirror_credential_row(user, credentials_name: str) -> None:
    """Make the stored credential VISIBLE to the env table.

    Writing the token into SOD is not enough: merge_env_tables joins a provider
    row to a user EnvVar by name, so without this row a genuinely-connected
    provider reads as MISSING. The row is value-free — the token stays in SOD;
    this only records that it exists.
    """
    from flow_sdk.app.actions.env_var import add_env_var_to_entity  # noqa: PLC0415
    from flow_sdk.core.entity.entity_env.env_types import EnvVarType  # noqa: PLC0415

    try:
        await add_env_var_to_entity(
            user, credentials_name, EnvVarType.OAUTH_TOKEN, skip_if_exists=True
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("could not mirror credential row %s: %s", credentials_name, e)


async def _drop_credential_row(user, credentials_name: str) -> None:
    """Remove the visibility row when the credential goes away."""
    try:
        if user.get_env_var(credentials_name) is not None:
            user.remove_env_var(credentials_name)
            await user.update()
    except Exception as e:  # noqa: BLE001
        logger.warning("could not drop credential row %s: %s", credentials_name, e)


async def _stamp_identity(user, name: str, provider: str, value: Any) -> None:
    """Record WHICH provider account the freshly-held token belongs to.

    Latest login wins is right, but a consumer that was granted account A must be
    able to notice it is now pointed at account B. Best effort: a provider that
    does not say leaves `account_key` None, and a None never counts as a match.
    """
    from flow_sdk.core.oauth.provider_probe import account_key_from  # noqa: PLC0415

    try:
        body = value if isinstance(value, dict) else {}
        row = user.get_env_var(name)
        if row is None:
            return
        row.account_key = account_key_from(provider, body)
        row.connected_at = int(time.time())
        user.set_env_var(row)
        await user.update()
    except Exception:  # noqa: BLE001 — never fail a good credential write on this
        logger.debug("could not stamp identity on %s", name, exc_info=True)


async def record_credential(user, provider: str, value: Any) -> bool:
    """THE place a provider credential is written. Latest login wins.

    One seam rather than a save function per provider, because "latest wins" is
    not just an overwrite — it is a moment at which several things must become
    true together: the value lands in SOD, the visibility row exists (without it
    `merge_env_tables` reads a genuinely-connected provider as MISSING), and the
    caches that answer "is this connected?" are dropped. Three writers each doing
    their own subset is how those drift apart.

    The credential NAME comes from the registry, never a literal — a name typed
    at the write site and resolved from the registry at the read site is a
    silently-unreadable token.
    """
    from flow_sdk.request_context.methods import set_user_credentials  # noqa: PLC0415

    name = user_credentials_name(provider)
    if not name:
        logger.warning("record_credential: unknown provider %r", provider)
        return False
    try:
        await set_user_credentials(user, name, value, user.id)
        await _mirror_credential_row(user, name)
        await _stamp_identity(user, name, provider, value)
    except Exception as e:  # noqa: BLE001
        logger.error("record_credential(%s) failed: %s", provider, e)
        return False

    # The provider catalogue caches connectedness for 10 minutes; a fresh grant
    # that is not visible until then reads to the user as "it did not work".
    try:
        from flow_sdk.core.oauth.hub_providers import invalidate_hub_providers  # noqa: PLC0415

        invalidate_hub_providers()
    except Exception:  # noqa: BLE001 — never fail a good write on a cache drop
        logger.debug("record_credential: could not invalidate provider cache", exc_info=True)
    return True


async def _save_token_for_session_user(user_id: str, provider: str, value: Any) -> bool:
    """`record_credential` for a flow that only holds the session's user id."""
    user = await _resolve_auth_session_user(user_id)
    if not user:
        logger.warning("no user found for id=%r while saving %s credential", user_id, provider)
        return False
    return await record_credential(user, provider, value)


def _normalize_credential_dict(provider: LocalOAuthProvider, token_response: dict) -> dict:
    """The stored shape for a CREDENTIAL_DICT provider.

    Persists only Flowpad-owned OAuth fields — never the harness's own
    credentials. Selected by ``TokenShape``, not by provider name, so this is
    the one place a provider's token shape is allowed to matter.
    """
    now = int(time.time() * 1000)
    expires_at = token_response.get("expires_at")
    expires_in = token_response.get("expires_in")
    if expires_at is None and expires_in is not None:
        try:
            expires_at = now + int(expires_in) * 1000
        except (TypeError, ValueError):
            expires_at = None

    scope = token_response.get("scope")
    scopes = token_response.get("scopes")
    if scopes is None and isinstance(scope, str):
        scopes = scope.split()

    credentials = {
        "provider": provider.name,
        "access_token": token_response.get("access_token"),
        "refresh_token": token_response.get("refresh_token"),
        "token_type": token_response.get("token_type"),
        "scope": scope,
        "scopes": scopes or [],
        "expires_at": expires_at,
        "created_at": now,
    }
    for key in (
        "account",
        "account_uuid",
        "email",
        "organization",
        "organization_name",
        "organization_uuid",
        "subscription_type",
        "rate_limit_tier",
    ):
        if key in token_response:
            credentials[key] = token_response[key]
    return credentials


async def _save_token_response(user_id: str, provider_name: str, token_response: dict) -> bool:
    """Normalize a token response to its provider's stored shape, then record it."""
    provider = get_local_provider(provider_name)
    if provider is None:
        logger.warning("_save_token_response: unknown provider %r", provider_name)
        return False

    if provider.token_shape is TokenShape.CREDENTIAL_DICT:
        value: Any = _normalize_credential_dict(provider, token_response)
        has_token = bool(value.get("access_token"))
    else:
        value = token_response.get("access_token")
        has_token = bool(value)

    if not has_token:
        logger.warning("%s token response did not include access_token", provider_name)
        return False
    return await _save_token_for_session_user(user_id, provider_name, value)


async def get_anthropic_token_for_current_user() -> tuple[dict | None, str | None]:
    """Return ``(credentials, error)`` for the current request user."""
    try:
        from flow_sdk.builtin.user import User
        from flow_sdk.request_context.methods import get_current_request_info, get_user_credentials

        request_info = get_current_request_info()
        if not request_info or not getattr(request_info, "user", None):
            return None, None
        user = await User.get_by_typeid(request_info.user)
        if not user:
            return None, None
        try:
            credentials = await get_user_credentials(user, ANTHROPIC_CREDENTIALS_NAME, user.id)
            return credentials if isinstance(credentials, dict) else None, None
        except KeyError:
            return None, None
    except Exception as e:
        logger.warning(f"Anthropic token lookup failed: {e}")
        return None, str(e)


async def delete_anthropic_token_for_current_user() -> ApiResponse:
    """Delete the current user's Flowpad-owned Anthropic OAuth SOD entry."""
    try:
        from flow_sdk.builtin.user import User
        from flow_sdk.request_context.methods import delete_user_credentials, get_current_request_info

        request_info = get_current_request_info()
        if not request_info or not getattr(request_info, "user", None):
            return ApiFailResponse(message="No request user")
        user = await User.get_by_typeid(request_info.user)
        if not user:
            return ApiFailResponse(message="User not found")
        await delete_user_credentials(user, ANTHROPIC_CREDENTIALS_NAME, user.id)
        await _drop_credential_row(user, ANTHROPIC_CREDENTIALS_NAME)
        return ApiSuccessResponse(
            message="Anthropic disconnected",
            data={"remaining_attachment_count": 0},
        )
    except Exception as e:
        logger.exception(f"Anthropic disconnect error: {e}")
        return ApiFailResponse(message=f"Anthropic disconnect error: {e}")


async def _poll_device_until_done(
    session: DesktopOAuthSession,
    http_timeout: Optional[float] = None,
) -> ApiResponse:
    """Poll GitHub's token endpoint until success / denied / expired / cancelled / http-timeout.

    Honors slow_down (RFC 8628 §3.5: +5s per occurrence) with a hard cap at
    ``DEVICE_POLL_INTERVAL_CAP_SECONDS`` so the modal countdown can't outrun
    polling. Uses ``time.monotonic()`` for the deadline so wall-clock skew
    (NTP step, sleep/resume) can't extend the window arbitrarily.

    ``http_timeout``: if set, the loop exits with ``status="polling"`` after
    this many seconds — without consuming the device-code session. The caller
    (wait-callback HTTP handler) returns to the client well under any proxy
    keep-alive limit; the user can re-issue wait-callback to resume polling
    against the same session, or the WebSocket broadcast remains the
    out-of-band signal."""

    started_monotonic = time.monotonic()

    async def _broadcast_error(message: str) -> ApiResponse:
        await _broadcast_llm_config_msg(
            is_configured=False, auth_method="github",
            oauth_request_id=session.state, status=OAuthMessageStatus.ERROR,
        )
        _desktop_oauth_sessions.pop(session.state, None)
        return ApiFailResponse(message=message)

    while True:
        # http_timeout check — return "polling" WITHOUT popping the session so a
        # re-issued wait-callback can resume against the same device_code.
        if (
            http_timeout is not None
            and time.monotonic() - started_monotonic >= http_timeout
        ):
            return ApiSuccessResponse(
                data={"status": "polling", "state": session.state},
                message="GitHub device flow still polling; WebSocket broadcast will fire on completion",
            )
        # 0. Cancellation check (set by /oauth/github/cancel).
        if session.cancel_event is not None and session.cancel_event.is_set():
            return await _broadcast_error("GitHub device flow cancelled")

        # 1. Deadline check before sleeping AND after sleeping, against monotonic.
        if (
            session.expires_at_monotonic is not None
            and time.monotonic() >= session.expires_at_monotonic
        ):
            return await _broadcast_error("GitHub device code expired before authorization")

        # 2. Sleep capped at remaining lifetime so we don't sleep past expiry.
        remaining = (
            (session.expires_at_monotonic - time.monotonic())
            if session.expires_at_monotonic is not None
            else session.poll_interval
        )
        sleep_for = max(0.1, min(session.poll_interval, remaining))
        # Make the sleep cancellable by the cancel_event: race the sleep vs the
        # cancel signal so cancellation is honored within poll_interval.
        if session.cancel_event is not None:
            cancel_wait = asyncio.create_task(session.cancel_event.wait())
            sleep_task = asyncio.create_task(asyncio.sleep(sleep_for))
            done, pending = await asyncio.wait(
                {cancel_wait, sleep_task}, return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            if session.cancel_event.is_set():
                return await _broadcast_error("GitHub device flow cancelled")
        else:
            await asyncio.sleep(sleep_for)

        # 3. Token exchange — network failures are transient, retry next loop.
        result = await _exchange_device_code(session)
        kind = result["kind"]

        if kind == "pending":
            continue
        if kind == "transient":
            # Network blip, DNS failure, timeout — keep polling without bumping
            # interval (slow_down is the explicit rate-limit signal, not this).
            logger.warning(f"GitHub poll transient error, will retry: {result.get('message')}")
            continue
        if kind == "slow_down":
            session.poll_interval = min(
                session.poll_interval + 5, DEVICE_POLL_INTERVAL_CAP_SECONDS,
            )
            continue
        if kind == "denied":
            return await _broadcast_error("User denied GitHub authorization")
        if kind == "expired":
            return await _broadcast_error("GitHub device code expired")
        if kind == "error":
            return await _broadcast_error(f"GitHub device flow error: {result.get('message')}")
        if kind == "success":
            # Stash the token on the session BEFORE attempting to persist; if save
            # fails we keep it around (and the session itself) so a later
            # /retry-save can recover the grant without forcing the user back
            # through github.com.
            session.pending_access_token = result["access_token"]
            saved = await _save_token_for_session_user(session.user_id, session.provider, result["access_token"])
            await _broadcast_llm_config_msg(
                is_configured=saved, auth_method="github",
                oauth_request_id=session.state,
                status=OAuthMessageStatus.SUCCESS if saved else OAuthMessageStatus.ERROR,
            )
            if not saved:
                logger.error(
                    f"GitHub OAuth authorized for user_id={session.user_id!r} but token "
                    f"could not be persisted to SOD; token retained on session "
                    f"state={session.state!r} for /retry-save (token NOT logged)."
                )
                # Keep the session alive so /retry-save can find the pending_access_token.
                return ApiFailResponse(message="Authorized but could not persist token; retry available")
            session.pending_access_token = None
            _desktop_oauth_sessions.pop(session.state, None)
            # The github capability's availability just changed out-of-band —
            # restamp so journey awaits / capability views flip immediately.
            from flow_sdk.builtin.capability import restamp_capability_state
            from flow_sdk.core.capabilities import CapabilityKind

            await restamp_capability_state(CapabilityKind.GITHUB.value)
            return ApiSuccessResponse(message="GitHub connected")


def cancel_github_device_flow(state: str) -> bool:
    """Signal a running github device-flow poll to abort.

    Returns True if the session was found and a cancel signal was raised.
    The background task will exit at its next loop iteration (within
    poll_interval seconds), broadcast an ERROR LlmConfigMessage, and remove
    itself from ``_desktop_oauth_sessions``."""
    session = _desktop_oauth_sessions.get(state)
    if session is None or session.cancel_event is None:
        return False
    session.cancel_event.set()
    return True


async def wait_for_desktop_oauth_callback(state: str, timeout: int = OAUTH_CALLBACK_TIMEOUT) -> ApiResponse:
    """Wait for OAuth callback / device-flow polling to complete and save credentials."""
    session = _desktop_oauth_sessions.get(state)
    if not session:
        return ApiFailResponse(message="OAuth session not found")

    # GitHub device flow: poll inline, bounded by the documented timeout so the
    # HTTP request resolves well under any proxy keep-alive limit. If the user
    # hasn't authorized within ``timeout`` seconds, the loop returns "polling"
    # WITHOUT consuming the session — a re-issued wait-callback resumes against
    # the same device_code. The WebSocket broadcast remains the canonical
    # signal whenever polling eventually finishes.
    if session.provider == "github":
        return await _poll_device_until_done(session, http_timeout=timeout)

    try:
        result = await session.wait_for_callback(timeout)
        if not result:
            if state in _desktop_oauth_sessions:
                del _desktop_oauth_sessions[state]
            return ApiFailResponse(message="OAuth callback failed - no code received")

        code, received_state = result

        # Exchange code for token and save credentials
        return await handle_desktop_oauth_callback(code, received_state)
    except ValueError as e:
        error_msg = str(e)
        if state in _desktop_oauth_sessions:
            del _desktop_oauth_sessions[state]
        return ApiFailResponse(message=error_msg)


async def handle_desktop_oauth_callback(code: str, state: str) -> ApiResponse:
    """Handle OAuth callback: exchange code for token and save credentials.

    Ported from FlowPad: flowpad/hub/app/actions/oauth/desktop_oauth.py
    """
    session = _desktop_oauth_sessions.get(state)
    if not session:
        return ApiFailResponse(message="OAuth session not found")

    try:
        # Handle CODE#STATE format (Anthropic sometimes returns code as "CODE#STATE")
        code_parts = code.split("#", 1)
        actual_code = code_parts[0]
        code_state = code_parts[1] if len(code_parts) > 1 else None
        final_state = code_state if code_state else state

        provider = get_local_provider(session.provider)
        if provider is None or provider.endpoints is None:
            return ApiFailResponse(message=f"Unknown provider on session: {session.provider}")
        client_id = client_id_for(provider.name)

        # Prepare token exchange request
        token_data = {
            "grant_type": "authorization_code",
            "client_id": client_id,
            "redirect_uri": session.redirect_uri,
            "code": actual_code,
            "state": final_state,
            "code_verifier": session.code_verifier,
        }

        # Exchange code for token
        async with httpx.AsyncClient() as client:
            response = await client.post(
                provider.endpoints.token_url,
                json=token_data,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                timeout=30.0,
            )

            if response.status_code != 200:
                error_text = response.text
                try:
                    error_json = response.json()
                    if "error" in error_json:
                        error_obj = error_json.get("error", {})
                        if isinstance(error_obj, dict):
                            error_msg = error_obj.get("message", str(error_obj))
                        else:
                            error_msg = str(error_obj)
                    else:
                        error_msg = str(error_json)
                except Exception:
                    error_msg = error_text[:500]

                return ApiFailResponse(message=f"Token exchange failed (status {response.status_code}): {error_msg}")

            token_response = response.json()
            access_token = token_response.get("access_token")

            if not access_token:
                return ApiFailResponse(message="No access token in response")

            saved = await _save_token_response(session.user_id, session.provider, token_response)
            if not saved:
                return ApiFailResponse(
                    message=(
                        "Could not save Anthropic OAuth credentials to Flowpad's credential store. "
                        "No Claude Code credentials were written."
                    )
                )

            # Two messages, two meanings: the config change, and the flow ending.
            # The second is what closes the popup and triggers the attach.
            try:
                await _broadcast_llm_config_msg(
                    is_configured=True,
                    auth_method="anthropic",
                    oauth_request_id=state,
                    status=OAuthMessageStatus.SUCCESS,
                )
                await _broadcast_oauth_msg(state, OAuthMessageStatus.SUCCESS)
            except Exception as e:
                logger.error(f"Failed to send WebSocket success notification: {e}")

            # Clean up session
            if state in _desktop_oauth_sessions:
                del _desktop_oauth_sessions[state]

            logger.info(f"Desktop OAuth completed successfully for user {session.user_id}")

            return ApiSuccessResponse(message="OAuth authentication completed successfully")

    except Exception as e:
        logger.error(f"Desktop OAuth callback error: {e}")
        if state in _desktop_oauth_sessions:
            del _desktop_oauth_sessions[state]
        return ApiFailResponse(message=f"OAuth callback error: {str(e)}")
