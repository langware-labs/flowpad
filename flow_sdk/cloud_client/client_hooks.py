"""httpx hooks for hub-bound desktop client requests."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import httpx

from flow_sdk.cli.auth.credentials import load_credentials
from flow_sdk.cloud_client.auth_state import invalidate_hub_login
from flow_sdk.cloud_client.constants import EXPIRY_LEEWAY_SECONDS
from flow_sdk.cloud_client.error_reporter import hub_error_reporter


class HubAuthExpiredError(httpx.RequestError):
    """Raised when a request is aborted before network due to local expiry."""


# Request-extension marker set by ``CloudProxy``: this response's body is streamed
# straight back to the caller, so the hooks must not read it. Reading consumes the
# stream, and the proxy's ``aiter_raw()`` then raises ``StreamConsumed`` *after* the
# headers (carrying the hub's Content-Length) have already gone out — the caller
# gets a zero-byte body against a non-zero Content-Length, which the browser
# reports as a bare "Network Error" instead of the hub's real status and message.
PASSTHROUGH_EXTENSION = "flowpad_passthrough"


def _is_passthrough(response: httpx.Response) -> bool:
    try:
        return bool(response.request.extensions.get(PASSTHROUGH_EXTENSION))
    except RuntimeError:  # no request bound to the response
        return False


def build_event_hooks() -> dict[str, list[Any]]:
    """Build httpx async event hooks for the hub client."""
    return {"request": [_on_request], "response": [_on_response]}


def _is_public_auth_path(path: str) -> bool:
    return path.endswith("/login") or path.endswith("/signup")


@lru_cache(maxsize=1)
def _local_machine_id() -> str:
    """This machine's id, a stable per-host fingerprint sent as ``X-Machine-ID``.

    Sent on every hub call so a hub that chooses to machine-bind a key has
    something to compare against; the workspace login key is not machine-bound
    today, so a hub without an allowlist simply ignores it.
    """
    import hashlib  # noqa: PLC0415
    import platform  # noqa: PLC0415
    import uuid  # noqa: PLC0415

    parts = [platform.system(), platform.machine(), hex(uuid.getnode())]
    try:
        system = platform.system()
        if system == "Linux":
            with open("/etc/machine-id") as f:
                parts.append(f.read().strip())
        elif system == "Darwin":
            import subprocess  # noqa: PLC0415

            out = subprocess.check_output(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"]).decode()
            parts.append(out.split("IOPlatformUUID")[1].split('"')[1])
        elif system == "Windows":
            import subprocess  # noqa: PLC0415

            out = subprocess.check_output(["wmic", "csproduct", "get", "uuid"], shell=True).decode()
            parts.append(out.splitlines()[1].strip())
    except Exception:  # noqa: BLE001 — id still works from the base parts
        pass
    return hashlib.sha256("|".join(parts).encode()).hexdigest()


def attach_machine_id(headers) -> None:
    """Send this machine's id on every hub call.

    Harmless when the key carries no machine allowlist (the normal case): the hub
    ignores the header. Kept so a machine-bound key can still be honoured.
    """
    try:
        headers["X-Machine-ID"] = _local_machine_id()
    except Exception:  # noqa: BLE001 — never let identity attachment break a request
        pass


async def _on_request(request: httpx.Request) -> None:
    attach_machine_id(request.headers)
    if "Authorization" in request.headers or _is_public_auth_path(request.url.path):
        return

    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    api_key = get_instance_settings().cloud_api_key
    if api_key:
        request.headers["Authorization"] = f"Bearer {api_key}"
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
    # A proxied response belongs to the caller downstream — inspect status only.
    passthrough = _is_passthrough(response)
    if status_code < 400:
        if not passthrough and await _is_auth_failure_envelope(response):
            # HTTP-layer auth failure (envelope status=fail with auth marker).
            # This is a real credential rejection from the hub's identity
            # check, not a WS-handshake reject — drop login state.
            await invalidate_hub_login("rejected")
        return

    if not passthrough:
        await response.aread()
    # Every hub 4xx/5xx — including 401/402/424 — is surfaced through the
    # error reporter so it becomes a HubClientErrorInfo warning in the UI
    # (createHubRequestFailedWarning), carrying method/path/status/message
    # for debugging. We deliberately do NOT drop login state on a 401: the
    # status alone can't tell "not authenticated" from "not authorized for
    # this entity/action" (RBAC denial). Real credential loss is signalled
    # elsewhere — by an auth-failure envelope on a 2xx (handled above), or
    # by the hub closing the WS with an auth close code (handled in
    # ws_client._handle_closed_connection).
    await hub_error_reporter.report(
        status_code=status_code,
        method=response.request.method,
        path=request_path(response.request.url),
        # The body is off-limits on a passthrough; the status still gets reported,
        # and the caller receives the hub's message verbatim in the proxied body.
        message=f"HTTP {status_code}" if passthrough else _response_message(response),
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
    # ``/current-user`` exists ONLY to resolve the caller's identity from their
    # token. A 2xx *fail* envelope there means the token did not resolve to a
    # user — a credential rejection — no matter the exact hub wording ("user
    # not found", "request info not found", "failed to resolve current user",
    # …). Match on the path alone so a hub message-copy change can't silently
    # stop clearing invalid/stale creds. (Genuine 4xx/5xx server errors take the
    # status>=400 branch in ``_on_response`` and never reach here.)
    if path.endswith("/current-user"):
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
