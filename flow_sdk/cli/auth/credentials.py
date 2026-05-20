#!/usr/bin/env python3
"""Per-instance hub credential storage.

Credentials live in the per-instance encrypted ``sodot`` file as four
separate sod entries: ``api_key``, ``refresh_token``, ``expires_at`` (as
string), ``user`` (as JSON string). The accessor is
``get_instance_settings().sod`` — see ``flow_sdk/instance_settings``.

The consent gate on ``instance.sod`` means ``save_credentials`` will raise
``SecretsNotEnabledError`` if called before ``enable_secrets()``. The
canonical login flow already calls ``enable_secrets`` before reaching
save (via the bootstrap explanation page → user approval → re-invoked
callback path); the no-op defensive call in
``cloud_login._finalize_login`` keeps the invariant load-bearing for any
non-canonical caller.

Phase C of the InstanceSettings consolidation. The legacy OS keychain
``Flowpad.ai.app_secrets/flowpad_api_key[:<instance>]`` entries are no
longer read or written here; the migration script at
``system_projects/flowpad_assistant/migrations/0.2.26/scripts/migrate.py``
leaves them in place for rollback safety but does not bootstrap them
into the new sodot.
"""

from __future__ import annotations

import json
import time
from typing import Any

from pydantic import BaseModel, Field


# Well-known sod entry names. Stable wire format inside the sodot file —
# treat as a small public contract.
SOD_API_KEY = "api_key"
SOD_REFRESH_TOKEN = "refresh_token"
SOD_EXPIRES_AT = "expires_at"
SOD_USER = "user"


def _sod():
    """Lazy import so the module loads cleanly even before any sod use."""
    from flow_sdk.instance_settings import get_instance_settings
    return get_instance_settings().sod


class UserHubCredentials(BaseModel):
    """Lossless-enough desktop credential record for hub login data."""

    api_key: str
    expires_at: float | None = None
    refresh_token: str | None = None
    user: dict[str, Any] = Field(default_factory=dict)

    @classmethod
    def from_login_payload(cls, payload: Any) -> "UserHubCredentials":
        """Create credentials from a hub LoginData-like object or dict."""
        if isinstance(payload, BaseModel):
            data = payload.model_dump(mode="json")
        elif isinstance(payload, dict):
            data = payload
        else:
            raise TypeError(f"Unsupported login payload type: {type(payload)!r}")

        api_key = data.get("api_key") or data.get("token")
        if not api_key:
            raise ValueError("login payload missing token/api_key")

        user = data.get("user") or {}
        if isinstance(user, BaseModel):
            user = user.model_dump(mode="json")

        return cls(
            api_key=api_key,
            expires_at=data.get("expires_at", data.get("expires")),
            refresh_token=data.get("refresh_token"),
            user=user,
        )

    @classmethod
    def from_login_data(cls, payload: Any) -> "UserHubCredentials":
        """Compatibility alias for LoginData-like payloads."""
        return cls.from_login_payload(payload)

    def to_login_payload(self) -> dict[str, Any]:
        """Return a LoginData-shaped dict."""
        return {
            "token": self.api_key,
            "expires": self.expires_at,
            "refresh_token": self.refresh_token,
            "user": self.user,
        }

    def is_expired(self, leeway_seconds: float = 0.0) -> bool:
        """Return true when credentials are locally expired."""
        if self.expires_at is None:
            return False
        return time.time() + leeway_seconds >= self.expires_at


def save_credentials(creds: UserHubCredentials) -> None:
    """Persist ``creds`` to the per-instance sodot file.

    Raises :class:`flow_sdk.instance_settings.SecretsNotEnabledError` if
    secrets have not been enabled (consent marker missing). Callers
    upstream of login should call ``enable_secrets()`` first.
    """
    sod = _sod()
    sod.write(SOD_API_KEY, creds.api_key)
    if creds.refresh_token is not None:
        sod.write(SOD_REFRESH_TOKEN, creds.refresh_token)
    else:
        sod.delete(SOD_REFRESH_TOKEN)
    if creds.expires_at is not None:
        sod.write(SOD_EXPIRES_AT, str(creds.expires_at))
    else:
        sod.delete(SOD_EXPIRES_AT)
    sod.write(SOD_USER, json.dumps(creds.user))


def load_credentials() -> UserHubCredentials | None:
    """Return the stored credentials or None if the user is not logged in.

    Returns None when secrets are not yet enabled — load is a read-only
    probe and shouldn't force a keychain prompt by raising.
    """
    from flow_sdk.instance_settings import SecretsNotEnabledError
    try:
        sod = _sod()
    except SecretsNotEnabledError:
        return None

    api_key = sod.read(SOD_API_KEY)
    if not api_key:
        return None

    expires_raw = sod.read(SOD_EXPIRES_AT)
    expires_at: float | None
    if expires_raw is None or expires_raw == "":
        expires_at = None
    else:
        try:
            expires_at = float(expires_raw)
        except ValueError:
            expires_at = None

    user_raw = sod.read(SOD_USER)
    if user_raw:
        try:
            user = json.loads(user_raw)
            if not isinstance(user, dict):
                user = {}
        except json.JSONDecodeError:
            user = {}
    else:
        user = {}

    return UserHubCredentials(
        api_key=api_key,
        refresh_token=sod.read(SOD_REFRESH_TOKEN),
        expires_at=expires_at,
        user=user,
    )


def clear_credentials() -> None:
    """Delete all credential sod entries. Idempotent. Safe to call when
    secrets aren't enabled (no-op rather than raise)."""
    from flow_sdk.instance_settings import SecretsNotEnabledError
    try:
        sod = _sod()
    except SecretsNotEnabledError:
        return
    for name in (SOD_API_KEY, SOD_REFRESH_TOKEN, SOD_EXPIRES_AT, SOD_USER):
        sod.delete(name)
