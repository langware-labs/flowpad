"""httpx hooks for hub-bound desktop client requests."""

from __future__ import annotations

from functools import lru_cache
from typing import Any

import httpx

from flow_sdk.cloud_client.auth_state import invalidate_hub_login
from flow_sdk.cloud_client.caller import current_caller
from flow_sdk.cloud_client.constants import EXPIRY_LEEWAY_SECONDS
from flow_sdk.cloud_client.error_reporter import hub_error_reporter
from flow_sdk.diagnose.baseline import redact


class HubAuthExpiredError(httpx.RequestError):
    """Raised when a request is aborted before network due to local expiry."""


# Request-extension marker set by ``HubProxy`` (a forwarded response): this response's body is streamed
# straight back to the caller, so the hooks must not read it. Reading consumes the
# stream, and the proxy's ``aiter_raw()`` then raises ``StreamConsumed`` *after* the
# headers (carrying the hub's Content-Length) have already gone out — the caller
# gets a zero-byte body against a non-zero Content-Length, which the browser
# reports as a bare "Network Error" instead of the hub's real status and message.
PASSTHROUGH_EXTENSION = "flowpad_passthrough"
# A request whose ENTITY ID is the credential (``public_role``: a diagnosis request's
# ``brief``/``submit``). This box's login is neither attached nor consulted -- a lapsed one must
# not stop a call that never needed it -- and the hub's answer to it can sign no one out here.
ANONYMOUS_EXTENSION = "flowpad_anonymous"


def _is_passthrough(response: httpx.Response) -> bool:
    try:
        return bool(response.request.extensions.get(PASSTHROUGH_EXTENSION))
    except RuntimeError:  # no request bound to the response
        return False


def _is_anonymous(request: httpx.Request) -> bool:
    return bool(request.extensions.get(ANONYMOUS_EXTENSION))


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

            # Windows 11 dropped wmic; through a shell, cmd printed "'wmic' is not recognized"
            # onto the user's console on every CLI run. Without a shell, a missing wmic is a
            # quiet FileNotFoundError and the id stays the base parts it already was there.
            out = subprocess.check_output(["wmic", "csproduct", "get", "uuid"], stderr=subprocess.DEVNULL).decode()
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


async def resolve_hub_credential(request: httpx.Request | None = None) -> str | None:
    """THE answer to "what does a hub call authenticate with" — None when nothing.

    The instance ``cloud_api_key`` (headless / e2b) first, else this user's stored login.
    The user record (``is_logged_in``) and the stored credential are separate, and they
    disagree when the credential is missing or unreadable: the UI says signed in while every
    call goes out bare. That disagreement signs the user out here, so the one record everyone
    reads tells the truth. An expired credential also aborts the call before it reaches the
    network (``HubAuthExpiredError``).
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    api_key = get_instance_settings().cloud_api_key
    if api_key:
        return api_key

    from flow_sdk.cli.auth.credentials import load_credentials  # lazy: cli imports cloud_client
    from flow_sdk.cli.auth.hub_login import is_logged_in  # noqa: PLC0415

    creds = load_credentials()
    if not creds:
        if is_logged_in():
            await invalidate_hub_login("credentials_missing")
        return None

    if creds.is_expired(EXPIRY_LEEWAY_SECONDS):
        await invalidate_hub_login("expired")
        raise HubAuthExpiredError("hub auth expired", request=request)
    return creds.api_key


async def _on_request(request: httpx.Request) -> None:
    attach_machine_id(request.headers)
    if _is_anonymous(request) or "Authorization" in request.headers or _is_public_auth_path(request.url.path):
        return
    credential = await resolve_hub_credential(request)
    if credential:
        request.headers["Authorization"] = f"Bearer {credential}"


async def _on_response(response: httpx.Response) -> None:
    status_code = response.status_code
    # A proxied response belongs to the caller downstream — inspect status only.
    passthrough = _is_passthrough(response)
    # No credential went out, so no answer to it says anything about this box's login.
    anonymous = _is_anonymous(response.request)
    if status_code < 400:
        if not passthrough and not anonymous and await _is_auth_failure_envelope(response):
            # HTTP-layer auth failure (envelope status=fail with auth marker).
            # This is a real credential rejection from the hub's identity
            # check, not a WS-handshake reject — drop login state.
            await invalidate_hub_login("rejected", detail=_auth_signal_detail(response))
            return
        if hub_error_reporter.has_failing:  # skip the redaction on the common, nothing-failed path
            await hub_error_reporter.recovered(
                method=response.request.method, path=redact(request_path(response.request.url))
            )
        return

    body_read = not passthrough or _is_small_json(response)
    if passthrough and body_read:
        # A forwarded error is a small JSON envelope: read it (``relay`` sends the read copy), so
        # the report carries the hub's own reason and a dead credential still signs this box out.
        await response.aread()
        if status_code == 401 and not anonymous and _error_code(response) == "unauthenticated":
            await invalidate_hub_login("rejected", detail=_auth_signal_detail(response))
    if not passthrough:
        await response.aread()
        # The one code that means the credential is dead (the hub sets it on nothing else).
        if not anonymous and _error_code(response) == "unauthenticated":
            await invalidate_hub_login("rejected", detail=_auth_signal_detail(response))
    # Every hub 4xx/5xx — including 401/402/424 — is surfaced through the
    # error reporter so it becomes a HubClientErrorInfo warning in the UI
    # (createHubRequestFailedWarning), carrying method/path/status/message
    # for debugging. We deliberately do NOT drop login state on a 401: the
    # status alone can't tell "not authenticated" from "not authorized for
    # this entity/action" (RBAC denial). Real credential loss is signalled
    # elsewhere — by an auth-failure envelope on a 2xx (handled above), or
    # by the hub closing the WS with an auth close code (handled in
    # ws_client._handle_closed_connection).
    path = redact(request_path(response.request.url))
    # A large or non-JSON passthrough body stays unread (the proxy streams it); the status
    # still gets reported, and the caller receives the body verbatim.
    message = redact(_response_message(response)) if body_read else f"HTTP {status_code}"
    await hub_error_reporter.report(
        status_code=status_code,
        method=response.request.method,
        path=path,
        message=message,
        detail=_error_detail(response, path=path, message=message, body_read=body_read),
    )


def _error_detail(response: httpx.Response, *, path: str, message: str, body_read: bool) -> dict[str, Any]:
    """The failed call as the UI's ``ErrorDetail``: request, the hub's answer, who asked."""
    url = response.request.url
    request_id = next((response.headers[h] for h in REQUEST_ID_HEADERS if h in response.headers), None)
    return {
        "request": {
            "method": response.request.method,
            "url": f"{url.scheme}://{url.netloc.decode()}{path}",
            "caller": current_caller() or None,
        },
        "response": {
            "status": response.status_code,
            "message": message,
            "body": redact(response.text or "")[:MAX_BODY_CHARS] if body_read else None,
            "errorCode": _error_code(response) if body_read else None,
            "requestId": request_id,
        },
    }


# A forwarded error body is read only when it is small JSON — an envelope, not a download.
MAX_READ_BYTES = 64 * 1024
MAX_BODY_CHARS = 4096
REQUEST_ID_HEADERS = ("x-request-id", "x-correlation-id", "x-amzn-trace-id")


def _is_small_json(response: httpx.Response) -> bool:
    if "json" not in response.headers.get("content-type", ""):
        return False
    length = response.headers.get("content-length")
    return length is not None and length.isdigit() and int(length) <= MAX_READ_BYTES


def _auth_signal_detail(response: httpx.Response) -> str:
    """Which hub answer claimed the credential is dead — logged with the verdict."""
    return f"{response.request.method} {request_path(response.request.url)} -> {response.status_code}: {_response_message(response)}"


def _error_code(response: httpx.Response) -> str | None:
    """The FAIL envelope's ``data.error_code``, or None."""
    try:
        data = (response.json() or {}).get("data")
    except Exception:  # noqa: BLE001 — not JSON: a load balancer page carries no code
        return None
    return data.get("error_code") if isinstance(data, dict) else None


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
