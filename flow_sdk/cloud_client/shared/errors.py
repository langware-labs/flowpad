"""Hub HTTP error type + reason extraction — shared by all cloud HTTP callers."""
from __future__ import annotations

import httpx


class HubError(Exception):
    """Raised when a hub HTTP call fails (transport error or non-2xx response).

    `status_code` is 0 for transport errors (DNS, timeout, refused, etc.).
    `reason` is a short human-readable string suitable for surfacing to end users.
    """

    def __init__(self, status_code: int, reason: str):
        self.status_code = status_code
        self.reason = reason
        super().__init__(f"hub error {status_code}: {reason}")


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
