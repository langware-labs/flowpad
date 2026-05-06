#!/usr/bin/env python3
"""Canonical hub credential storage.

The keyring slot used to store a raw API key now stores a JSON credential
record. Legacy raw-string values are migrated on first read.
"""

from __future__ import annotations

import json
import time
from typing import Any

import keyring
from pydantic import BaseModel, Field


SERVICE_NAME = "Flowpad.ai.app_secrets"


def _api_key_name() -> str:
    """Per-instance keyring username."""
    from flow_sdk.instance_settings import get_instance_settings

    name = get_instance_settings().instance_name
    return "flowpad_api_key" if name == "prod" else f"flowpad_api_key:{name}"


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
    """Store credentials as JSON in the existing keyring slot."""
    keyring.set_password(SERVICE_NAME, _api_key_name(), creds.model_dump_json())


def load_credentials() -> UserHubCredentials | None:
    """Load credentials, migrating legacy raw API-key strings on first read."""
    raw = keyring.get_password(SERVICE_NAME, _api_key_name())
    if not raw:
        return None

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        creds = UserHubCredentials(api_key=raw)
        save_credentials(creds)
        return creds

    if isinstance(parsed, dict):
        if "api_key" in parsed:
            return UserHubCredentials.model_validate(parsed)
        if "token" in parsed:
            creds = UserHubCredentials.from_login_payload(parsed)
            save_credentials(creds)
            return creds

    creds = UserHubCredentials(api_key=parsed if isinstance(parsed, str) else raw)
    save_credentials(creds)
    return creds


def clear_credentials() -> None:
    """Delete the credential keyring entry. Idempotent."""
    try:
        keyring.delete_password(SERVICE_NAME, _api_key_name())
    except keyring.errors.PasswordDeleteError:
        pass
