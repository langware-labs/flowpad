"""Hub HTTP error type + reason extraction — shared by all cloud HTTP callers."""

from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from flow_sdk.schema.data_spec.hub_failure_spec import HubFailure, HubFailureKind


class HubErrorCode(str, Enum):
    """Machine-readable markers the hub attaches to FAIL envelopes at
    ``data.error_code``. Match on these — never on ``reason`` prose, which
    the hub is free to reword. Mirrors the hub-side
    ``flowpad.hub.core.request_context.auth_info.AuthErrorCode``.
    """

    # The target entity doesn't exist OR the caller holds no role on it —
    # the hub deliberately doesn't distinguish, so entity existence doesn't leak.
    TARGET_NOT_FOUND = "target_not_found"
    # The credential itself is dead (missing, unverifiable, revoked, expired). The one
    # signal to sign out on: a bare 401 also means "this key may not do that".
    UNAUTHENTICATED = "unauthenticated"


#: Statuses an older hub answers for a dead JWT, before it carried ``unauthenticated``.
_SIGNED_OUT_STATUSES = frozenset({402, 412, 424})
#: 4xx that mean "not now", not "no": the request was fine, the moment was not.
_TRANSIENT_4XX = frozenset({408, 425, 429})


def classify_hub_failure(status_code: int, code: str | None = None) -> "HubFailureKind":
    """The one mapping from a hub answer to what kind of failure it is.

    Status first, the envelope's code as detail: what stands in front of the hub (a load
    balancer's HTML 502) never carries an envelope.
    """
    from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind  # noqa: PLC0415 — keep this module light

    if code == HubErrorCode.UNAUTHENTICATED:
        return HubFailureKind.SIGNED_OUT
    if status_code == 0:
        return HubFailureKind.OFFLINE
    if status_code in _SIGNED_OUT_STATUSES:
        return HubFailureKind.SIGNED_OUT
    if status_code >= 500 or status_code in _TRANSIENT_4XX:
        return HubFailureKind.SERVER_ERROR
    return HubFailureKind.REJECTED


class HubError(Exception):
    """Raised when a hub HTTP call fails (transport error or non-2xx response).

    `status_code` is 0 for transport errors (DNS, timeout, refused, etc.).
    `reason` is a short human-readable string suitable for surfacing to end users.
    `code` is the hub's machine-readable ``data.error_code`` marker when the
    envelope carried one (see ``HubErrorCode``) — None otherwise.
    """

    def __init__(self, status_code: int, reason: str, code: str | None = None, kind: "HubFailureKind | None" = None):
        self.status_code = status_code
        self.reason = reason
        self.code = code
        # Given when the status alone cannot say it: no hub configured, no credential to send.
        self.kind = kind or classify_hub_failure(status_code, code)
        super().__init__(f"hub error {status_code}: {reason}")

    @property
    def failure(self) -> "HubFailure":
        """This error as the value every surface reads."""
        from flow_sdk.schema.data_spec.hub_failure_spec import HubFailure  # noqa: PLC0415

        return HubFailure(
            kind=self.kind, status=self.status_code or None, code=self.code, message=self.user_message()
        )

    def fail_response(self, prefix: str):
        """This failure as an action's answer: the sentence, the status that names whose fault
        it is, and ``data.error_code`` for the UI to match (never the prose)."""
        from flow_sdk.responses.response import ApiFailResponse  # noqa: PLC0415
        from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind  # noqa: PLC0415

        status = {
            HubFailureKind.SIGNED_OUT: 401,
            HubFailureKind.NOT_CONFIGURED: 503,
            HubFailureKind.REJECTED: self.status_code if self.status_code >= 400 else 400,
        }.get(self.kind, 502)
        return ApiFailResponse(
            message=f"{prefix}: {self.user_message()}",
            status_code=status,
            data={"error_code": self.kind.value, "hub_status": self.status_code or None, "hub_code": self.code},
        )

    def user_message(self) -> str:
        """One sentence a person can act on."""
        from flow_sdk.schema.data_spec.hub_failure_spec import HubFailureKind  # noqa: PLC0415

        if self.kind is HubFailureKind.OFFLINE:
            return "Can't reach the hub right now."
        if self.kind is HubFailureKind.NOT_CONFIGURED:
            return "This app is not connected to a hub."
        if self.kind is HubFailureKind.SIGNED_OUT:
            return "You're signed out — sign in to send this."
        if self.kind is HubFailureKind.SERVER_ERROR:
            return f"The hub answered {self.reason}." if self.reason.startswith("HTTP ") else self.reason
        return self.reason

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
    # Not JSON: a load balancer's error page, never something to show a person.
    return f"HTTP {resp.status_code} {resp.reason_phrase}".rstrip()


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
