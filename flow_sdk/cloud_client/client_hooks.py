"""httpx hooks for hub-bound desktop client requests."""

from __future__ import annotations

import os
from typing import Any

import httpx

from flow_sdk.cli.auth.credentials import load_credentials
from flow_sdk.cloud_client.auth_state import invalidate_hub_login
from flow_sdk.cloud_client.constants import EXPIRY_LEEWAY_SECONDS
from flow_sdk.cloud_client.error_reporter import hub_error_reporter


AUTH_FAILURE_STATUS_CODES = {401, 402, 424}


class HubAuthExpiredError(httpx.RequestError):
    """Raised when a request is aborted before network due to local expiry."""


def build_event_hooks() -> dict[str, list[Any]]:
    """Build httpx async event hooks for the hub client."""
    return {"request": [_on_request], "response": [_on_response]}


def _is_public_auth_path(path: str) -> bool:
    return path.endswith("/login") or path.endswith("/signup")


async def _on_request(request: httpx.Request) -> None:
    if "Authorization" in request.headers or _is_public_auth_path(request.url.path):
        return

    env_api_key = os.environ.get("FLOWPAD_CLOUD_API_KEY") or None
    if env_api_key:
        request.headers["Authorization"] = f"Bearer {env_api_key}"
        return

    creds = load_credentials()
    if not creds:
        return

    if creds.is_expired(EXPIRY_LEEWAY_SECONDS):
        await invalidate_hub_login("expired")
        raise HubAuthExpiredError("hub auth expired", request=request)

    request.headers["Authorization"] = f"Bearer {creds.api_key}"


async def _on_response(response: httpx.Response) -> None:
    status_code = response.status_code
    if status_code < 400:
        if await _is_auth_failure_envelope(response):
            await invalidate_hub_login("rejected")
        return

    await response.aread()
    path = request_path(response.request.url)
    if status_code in AUTH_FAILURE_STATUS_CODES:
        await invalidate_hub_login("rejected")
        return

    await hub_error_reporter.report(
        status_code=status_code,
        method=response.request.method,
        path=path,
        message=_response_message(response),
    )


async def _is_auth_failure_envelope(response: httpx.Response) -> bool:
    content_type = response.headers.get("content-type", "").lower()
    if "json" not in content_type:
        return False

    await response.aread()
    try:
        body = response.json()
    except Exception:
        return False

    if not isinstance(body, dict):
        return False

    status = str(body.get("status") or "").lower()
    if status not in {"fail", "failure", "error"}:
        return False

    message = _envelope_message(body).lower()
    path = response.request.url.path
    if path.endswith("/current-user") and (
        "user not found" in message or "request info not found" in message
    ):
        return True

    return any(
        marker in message
        for marker in (
            "unauthorized",
            "unauthenticated",
            "auth",
            "token",
            "jwt",
            "credential",
            "expired",
        )
    )


def request_path(url: httpx.URL) -> str:
    path = url.path
    if url.query:
        query = url.query.decode() if isinstance(url.query, bytes) else url.query
        path = f"{path}?{query}"
    return path


def _envelope_message(body: dict[str, Any]) -> str:
    for key in ("message", "detail", "error"):
        val = body.get(key)
        if val:
            return str(val)
    return ""


def _response_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except Exception:
        text = (response.text or "").strip()
        return text[:300] if text else f"HTTP {response.status_code}"

    if isinstance(body, dict):
        return _envelope_message(body)[:300] or f"HTTP {response.status_code}"
    return f"HTTP {response.status_code}"
