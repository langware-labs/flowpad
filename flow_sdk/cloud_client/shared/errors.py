"""Hub HTTP error type + reason extraction — shared by all cloud HTTP callers."""

from __future__ import annotations

from enum import Enum

import httpx


class HubErrorCode(str, Enum):
    """Machine-readable markers the hub attaches to FAIL envelopes at
    ``data.error_code``. Match on these — never on ``reason`` prose, which
    the hub is free to reword. Mirrors the hub-side
    ``flowpad.hub.core.request_context.auth_info.AuthErrorCode``.
    """

    # The target entity doesn't exist OR the caller holds no role on it —
    # the hub deliberately doesn't distinguish, so entity existence doesn't leak.
    TARGET_NOT_FOUND = "target_not_found"


class HubError(Exception):
    """Raised when a hub HTTP call fails (transport error or non-2xx response).

    `status_code` is 0 for transport errors (DNS, timeout, refused, etc.).
    `reason` is a short human-readable string suitable for surfacing to end users.
    `code` is the hub's machine-readable ``data.error_code`` marker when the
    envelope carried one (see ``HubErrorCode``) — None otherwise.
    """

    def __init__(self, status_code: int, reason: str, code: str | None = None):
        self.status_code = status_code
        self.reason = reason
        self.code = code
        super().__init__(f"hub error {status_code}: {reason}")

    @property
    def is_target_missing(self) -> bool:
        """True when the hub's answer means "there is nothing there for you":
        a plain 404, or the authorizer's ``target_not_found`` code — emitted
        both when the entity is gone and when the caller holds no role on it
        (masked so entity existence doesn't leak).
        """
        return self.status_code == 404 or self.code == HubErrorCode.TARGET_NOT_FOUND


def _extract_reason(resp: httpx.Response) -> str:
    """Pull a short failure reason out of an httpx response body.

    Tries JSON `message` / `detail` / `error` first (the shapes flowpad-hub
    and FastAPI use), then falls back to the raw text trimmed to 300 chars.
    """
    try:
        body = resp.json()
        if isinstance(body, dict):
            for key in ("message", "detail", "error"):
                val = body.get(key)
                if val:
                    return str(val)
    except Exception:
        pass
    text = (resp.text or "").strip()
    if text:
        return text[:300]
    return f"HTTP {resp.status_code}"


def _extract_error_code(resp: httpx.Response) -> str | None:
    """Pull the hub's machine-readable ``data.error_code`` marker out of a
    FAIL envelope, or None when the body doesn't carry one."""
    try:
        body = resp.json()
        if isinstance(body, dict):
            data = body.get("data")
            if isinstance(data, dict):
                val = data.get("error_code")
                if val:
                    return str(val)
    except Exception:
        pass
    return None
