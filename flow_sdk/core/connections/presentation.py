"""Shared presentation primitives for connection authorization."""

from __future__ import annotations

import webbrowser

from flow_sdk.core.connections.types import Authorization, BrowserAuthorization


def open_authorization_in_system_browser(authorization: Authorization) -> bool:
    """Open one browser/device authorization, returning whether the OS accepted it."""
    url = authorization.url if isinstance(authorization, BrowserAuthorization) else authorization.verification_uri
    try:
        return bool(webbrowser.open(url))
    except Exception:  # noqa: BLE001 - callers print the same URL as the supported fallback
        return False
