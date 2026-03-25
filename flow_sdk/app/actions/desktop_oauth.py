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
from typing import Optional, Tuple
from urllib.parse import quote

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

from flow_sdk.api.messages import LlmConfigMessage, OAuthMessageStatus
from flow_sdk.app.actions.oauth_templates import OAUTH_ERROR_HTML, OAUTH_SUCCESS_HTML
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)

# OAuth callback timeout in seconds (2 minutes)
OAUTH_CALLBACK_TIMEOUT = 120

# Anthropic OAuth constants (from FlowPad plugins/anthropic/config.py)
ANTHROPIC_CLIENT_ID_DEFAULT = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
ANTHROPIC_AUTH_URL = "https://claude.ai/oauth/authorize"
ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
ANTHROPIC_SCOPES = ["user:profile", "user:inference", "user:sessions:claude_code"]


def _get_anthropic_client_id() -> str:
    """Get Anthropic OAuth client ID from env var or default."""
    return os.getenv("ANTHROPIC_CLIENT_ID", ANTHROPIC_CLIENT_ID_DEFAULT)


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
        self.callback_code: Optional[str] = None
        self.callback_state: Optional[str] = None
        self.callback_error: Optional[str] = None
        self.callback_server: Optional[asyncio.Task] = None
        self.callback_port: Optional[int] = None
        self.callback_event: asyncio.Event = asyncio.Event()

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


def _build_anthropic_auth_url(
    client_id: str,
    redirect_uri: str,
    state: str,
    code_challenge: str,
    scopes: list[str],
) -> str:
    """Build Anthropic OAuth authorization URL with PKCE parameters."""
    scope_str = " ".join(scopes)
    params = {
        "client_id": client_id,
        "scope": quote(scope_str, safe=""),
        "state": state,
        "redirect_uri": quote(redirect_uri, safe=""),
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "response_type": "code",
        "code": "true",
    }
    query_string = "&".join([f"{k}={v}" for k, v in params.items()])
    return f"{ANTHROPIC_AUTH_URL}?{query_string}"


async def get_desktop_oauth_auth_url(provider: str, user_id: str) -> ApiResponse:
    """Generate OAuth authorization URL for desktop mode with localhost callback.

    Ported from FlowPad: flowpad/hub/app/actions/oauth/desktop_oauth.py
    """
    if provider != "anthropic":
        return ApiFailResponse(message=f"Desktop OAuth not supported for provider: {provider}")

    client_id = _get_anthropic_client_id()

    # Generate PKCE
    code_verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("utf-8").rstrip("=")
    code_challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode("utf-8")).digest()).decode("utf-8").rstrip("=")
    )

    # Generate state
    state = secrets.token_urlsafe(32)

    # Find free port and create redirect URI
    callback_port = DesktopOAuthSession._find_free_port()
    redirect_uri = f"http://localhost:{callback_port}/callback"

    # Create session
    session = DesktopOAuthSession(
        state=state,
        code_verifier=code_verifier,
        redirect_uri=redirect_uri,
        user_id=user_id,
        provider=provider,
    )
    session.callback_port = callback_port

    # Start callback server
    session.callback_server = asyncio.create_task(session._start_callback_server(callback_port, state))
    _desktop_oauth_sessions[state] = session

    # Build authorization URL
    auth_url = _build_anthropic_auth_url(
        client_id=client_id,
        redirect_uri=redirect_uri,
        state=state,
        code_challenge=code_challenge,
        scopes=ANTHROPIC_SCOPES,
    )

    logger.info(f"Desktop OAuth auth URL generated for {provider}, port={callback_port}")

    return ApiSuccessResponse(
        data={
            "url": auth_url,
            "port": callback_port,
            "state": state,
        }
    )


async def wait_for_desktop_oauth_callback(state: str, timeout: int = OAUTH_CALLBACK_TIMEOUT) -> ApiResponse:
    """Wait for OAuth callback via localhost server, exchange code for token, and save credentials.

    Ported from FlowPad: flowpad/hub/app/actions/oauth/desktop_oauth.py
    """
    session = _desktop_oauth_sessions.get(state)
    if not session:
        return ApiFailResponse(message="OAuth session not found")

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

        client_id = _get_anthropic_client_id()

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
                ANTHROPIC_TOKEN_URL,
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

            # Save fresh OAuth tokens so Claude Code can pick them up
            from flow_sdk.builtin.faas.claude_code_auth import (
                detect_claude_code_auth,
                extract_user_profile_from_token_response,
                save_oauth_token_response,
            )

            save_oauth_token_response(token_response)

            # Detect auth status after saving
            claude_auth = await detect_claude_code_auth()
            llm_configured = claude_auth.is_authenticated

            # Extract user profile from token response
            user_profile = extract_user_profile_from_token_response(token_response)
            if user_profile:
                claude_auth.user_profile = user_profile

            # Send WebSocket notification that OAuth completed successfully
            try:
                await _broadcast_llm_config_msg(
                    is_configured=llm_configured,
                    auth_method=claude_auth.auth_method.value,
                    auth_data=claude_auth.model_dump(),
                    oauth_request_id=state,
                    status=OAuthMessageStatus.SUCCESS,
                )
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
