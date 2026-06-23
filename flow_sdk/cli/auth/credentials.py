#!/usr/bin/env python3
"""Per-instance hub credential storage.

Credentials live in the per-instance encrypted ``sodot`` file as four
separate sod entries: ``api_key``, ``refresh_token``, ``expires_at`` (as
string), ``user`` (as JSON string). The accessor is
``get_instance_settings().sod`` — see ``flow_sdk/instance_settings``.

``instance.sod`` is now always available — the Fernet key resolves lazily
(``SOD_ENC_KEY`` env, else keychain auto-mint) on first real read/write, and
the ``.secrets_enabled`` marker is auto-created on first use. So login is just
one more writer into the shared per-instance ``sodot``; it is no longer a
precondition for the store, and ``save_credentials`` no longer depends on a
prior ``enable_secrets()`` call. The defensive ``enable_secrets`` in
``cloud_login._finalize_login`` is retained only to pre-time the keychain
prompt at a friendly moment.

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
# treat as a small public contract. These names double as the per-field
# SUFFIX in the per-user scoped form (``user::<user_id>::<field>``) and as
# the LEGACY flat key names that pre-per-user instances still carry.
SOD_API_KEY = "api_key"
SOD_REFRESH_TOKEN = "refresh_token"
SOD_EXPIRES_AT = "expires_at"
SOD_USER = "user"

# Namespace segment for per-user scoped sod entries. Credentials are keyed by
# hub user id so multiple users coexist in one instance's sodot with no
# overwrite — the "natural separation, no cleanup" model. The active user is
# tracked separately as a pointer in config.json (app_config.get_user); SOD
# only holds the secrets.
SOD_USER_PREFIX = "user"


def _scoped_key(field: str, user_id: str) -> str:
    """Per-user sod entry name, e.g. ``user::<user_id>::api_key``."""
    return f"{SOD_USER_PREFIX}::{user_id}::{field}"


def _active_user_id() -> str | None:
    """Resolve the active hub user's id from the config.json pointer.

    This is the same record ``is_logged_in`` / ``hub_auth_available`` key off,
    so "the current user's credentials" means this user's scoped sod entries.
    Returns None when no user is logged in (then callers fall back to the
    legacy flat keys)."""
    from flow_sdk.cli.app_config import get_user  # noqa: PLC0415
    user = get_user()
    uid = user.get("id") if user else None
    return str(uid) if uid else None


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
    """Persist ``creds`` to the per-instance sodot file, keyed by user id.

    When ``creds.user`` carries an ``id`` (every hub login does), the four
    entries are written under per-user scoped keys (``user::<id>::<field>``)
    so a second user logging into the same instance does NOT overwrite the
    first user's token — natural separation, no cleanup. When there is no user
    id (the ``set_api_key`` headless path, ``creds.user == {}``), the legacy
    flat keys are written, exactly as before.

    The store is always available; the first write here resolves the Fernet
    key (env or keychain auto-mint) and auto-creates the consent marker. No
    prior ``enable_secrets()`` is required.
    """
    sod = _sod()

    uid = creds.user.get("id") if creds.user else None
    uid = str(uid) if uid else None

    def key(field: str) -> str:
        return _scoped_key(field, uid) if uid else field

    sod.write(key(SOD_API_KEY), creds.api_key)
    if creds.refresh_token is not None:
        sod.write(key(SOD_REFRESH_TOKEN), creds.refresh_token)
    else:
        sod.delete(key(SOD_REFRESH_TOKEN))
    if creds.expires_at is not None:
        sod.write(key(SOD_EXPIRES_AT), str(creds.expires_at))
    else:
        sod.delete(key(SOD_EXPIRES_AT))
    sod.write(key(SOD_USER), json.dumps(creds.user))


def load_credentials(user_id: str | None = None) -> UserHubCredentials | None:
    """Return the stored credentials or None if the user is not logged in.

    Resolves which user's credentials to read in this order:

    * ``user_id`` argument when given (the just-logged-in user during
      ``_finalize_login``, before the config.json pointer is committed);
    * else the active user from the config.json pointer (``_active_user_id``).

    Each field is read scoped-first (``user::<id>::<field>``) with a fallback
    to the LEGACY flat key — so instances written before per-user keying stay
    logged in, and re-login transparently upgrades them. When no user id
    resolves at all (e.g. the headless ``set_api_key`` path), only the flat
    keys are read.

    Returns None when secrets are not yet enabled — load is a read-only
    probe and shouldn't force a keychain prompt by raising.
    """
    from flow_sdk.instance_settings import SecretsNotEnabledError
    try:
        sod = _sod()
    except SecretsNotEnabledError:
        return None

    uid = user_id or _active_user_id()

    def read(field: str) -> str | None:
        if uid:
            scoped = sod.read(_scoped_key(field, uid))
            if scoped:
                return scoped
        return sod.read(field)

    api_key = read(SOD_API_KEY)
    if not api_key:
        return None

    expires_raw = read(SOD_EXPIRES_AT)
    expires_at: float | None
    if expires_raw is None or expires_raw == "":
        expires_at = None
    else:
        try:
            expires_at = float(expires_raw)
        except ValueError:
            expires_at = None

    user_raw = read(SOD_USER)
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
        refresh_token=read(SOD_REFRESH_TOKEN),
        expires_at=expires_at,
        user=user,
    )


def clear_credentials(user_id: str | None = None) -> None:
    """Delete one user's credential sod entries. Idempotent. Safe to call when
    secrets aren't enabled (no-op rather than raise).

    Resolves the target user from ``user_id`` else the active config.json
    pointer, and deletes only THAT user's scoped entries — other users'
    credentials are left intact. When no user id resolves, the legacy flat
    keys are deleted (the headless / logged-out path)."""
    from flow_sdk.instance_settings import SecretsNotEnabledError
    try:
        sod = _sod()
    except SecretsNotEnabledError:
        return
    uid = user_id or _active_user_id()
    for field in (SOD_API_KEY, SOD_REFRESH_TOKEN, SOD_EXPIRES_AT, SOD_USER):
        # Clear this user's scoped entries AND the legacy flat slot. The flat
        # slot is a single pre-per-user (or headless set_api_key) slot, not a
        # per-user one, so clearing it on logout never touches another user's
        # scoped credentials — but it does prevent a flat key from being
        # orphaned when creds were written flat yet cleared with a pointer set.
        if uid:
            sod.delete(_scoped_key(field, uid))
        sod.delete(field)
