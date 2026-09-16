"""Explicit browser login for a cloud sandbox, using the hub's PKCE JWT grant."""

import base64
import hashlib
import secrets
import time
from urllib.parse import urlencode

import httpx

from flow_sdk.cli.auth.cloud_login import _finalize_login
from flow_sdk.cli.auth.hub_login import validate_api_key_async
from flow_sdk.cloud_client import ApiConfig
from flow_sdk.cloud_client.api.auth import LoginData
from flow_sdk.compute.providers.compute_provider import sandbox_public_url
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.server import state

CLIENT_ID = "flowpad-sandbox"
# Verifiers never enter the public correlated-login response.
_verifiers: dict[str, tuple[str, str]] = {}


def start_sandbox_login(sandbox_id: str) -> dict:
    redirect_uri = sandbox_public_url(9007, sandbox_id) + "/auth/oauth_callback"
    hub = ApiConfig.from_env().api_base_url.rstrip("/")

    def authorize_url(request_id: str) -> str:
        verifier = secrets.token_urlsafe(32)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        _verifiers.clear()
        _verifiers[request_id] = (verifier, redirect_uri)
        return hub + "/oauth/authorize?" + urlencode({
            "client_id": CLIENT_ID, "response_type": "code", "redirect_uri": redirect_uri,
            "state": request_id, "code_challenge": challenge, "code_challenge_method": "S256",
        })

    session = state.start_cloud_login_session(authorize_url, get_instance_settings().cloud_login_timeout_seconds)
    return {"status": "started", "url": session["url"], "present_in_browser": True}


async def complete_sandbox_login(request_id: str, code: str) -> None:
    session = state.cloud_login_session_result(request_id)
    if not session or session["status"] != "pending" or not code:
        raise ValueError("This sign-in request is missing, expired, or already completed")
    binding = _verifiers.pop(request_id, None)
    if binding is None:
        raise ValueError("This sign-in request has already been claimed")
    verifier, redirect_uri = binding
    try:
        hub = ApiConfig.from_env().api_base_url.rstrip("/")
        async with httpx.AsyncClient() as client:
            response = await client.post(hub + "/oauth/token", data={
                "grant_type": "authorization_code", "client_id": CLIENT_ID,
                "code": code, "code_verifier": verifier, "redirect_uri": redirect_uri,
            })
            response.raise_for_status()
            payload = response.json()
        token = payload["access_token"]
        user = await validate_api_key_async(token)
        expires_in = payload.get("expires_in")
        await _finalize_login(LoginData(
            token=token, user=user, refresh_token=payload.get("refresh_token"),
            expires=time.time() + float(expires_in) if expires_in is not None else None,
        ))
        state.finish_cloud_login_session(request_id, success=True)
    except Exception:
        state.finish_cloud_login_session(request_id, success=False, detail="Sandbox sign-in failed")
        raise
