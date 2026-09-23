"""Hub login + connection status enums and WS messages.

These two enums are intentionally orthogonal:

* ``HubLoginStatus`` — do we have valid hub credentials and a known user?
  Owned by user actions (login/logout), clock-driven token expiry, and
  HTTP identity-check failures. Never flipped by a WS-layer failure.

* ``HubConnectionStatus`` — is the local server's outbound hub WebSocket up?
  Owned by socket lifecycle events. ``AUTH_REJECTED`` is the visible signal
  that "we are logged in but the hub will not let us in over WS" — exactly
  the state the UI must render cleanly.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Dict, Optional

from flow_sdk.api.messages import BaseMessage, WSMessageType


class HubLoginStatus(str, Enum):
    LOGGED_OUT = "logged_out"
    LOGGING_IN = "logging_in"
    LOGGED_IN = "logged_in"
    LOGIN_FAILED = "login_failed"


class HubConnectionStatus(str, Enum):
    DISCONNECTED = "disconnected"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    VERIFIED = "verified"
    AUTH_REJECTED = "auth_rejected"
    ERROR = "error"


class LogoutReason(str, Enum):
    """The one ``reason`` value on a LOGGED_OUT broadcast the frontend pattern-matches on.

    ``reason`` stays free text for everything else (human-readable expiry/
    rejection explanations) — this only names the value that tells the frontend
    "someone else just took this machine" so it drops the entity cache and shows
    ``SessionTakenOverOverlay`` instead of a quiet sign-out (``ts_sdk/src/
    services/cloud_login.ts``, ``_setLoggedOut``).
    """

    SWITCHED_OUT = "switched_out"


class CloudLoginStatusMessage(BaseMessage):
    message_type: str = WSMessageType.CLOUD_LOGIN_STATUS_MSG.value
    status: HubLoginStatus
    user: Optional[Dict[str, Any]] = None
    reason: Optional[str] = None


class CloudConnectionStatusMessage(BaseMessage):
    message_type: str = WSMessageType.CLOUD_CONNECTION_STATUS_MSG.value
    status: HubConnectionStatus
    error: Optional[str] = None
