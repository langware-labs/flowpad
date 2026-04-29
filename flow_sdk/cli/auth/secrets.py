"""App-secret management.

Secret values live in the OS keyring under ``SECRETS_SERVICE`` (distinct from
the hub API-key service). Secret metadata (name, description) lives in
``AppSecretRecord`` in the fs_store. Reading a secret value goes through
``read_secret`` only — never exposed via HTTP.

The "enable" sentinel is a separate keyring entry whose existence acts as a
probe for whether the user has approved keychain access for this app.
``is_secrets_enabled`` does a non-prompting read of the sentinel; the act of
writing the sentinel via ``enable_secrets`` is what triggers the OS approval
prompt.
"""

from __future__ import annotations

import keyring

from flow_sdk.fs_records.app_secret import AppSecretRecord


SECRETS_SERVICE = "Flowpad.ai.app_secrets"
SENTINEL_NAME = "__secrets_enabled_sentinel__"
SENTINEL_VALUE = "1"


def is_secrets_enabled() -> bool:
    try:
        return keyring.get_password(SECRETS_SERVICE, SENTINEL_NAME) == SENTINEL_VALUE
    except Exception:
        return False


def enable_secrets() -> bool:
    """Write the sentinel; OS may prompt the user. Return True iff readable after."""
    try:
        keyring.set_password(SECRETS_SERVICE, SENTINEL_NAME, SENTINEL_VALUE)
    except Exception:
        return False
    return is_secrets_enabled()


def disable_secrets() -> None:
    """Delete the enable-sentinel from the keyring (best-effort, never raises)."""
    try:
        keyring.delete_password(SECRETS_SERVICE, SENTINEL_NAME)
    except keyring.errors.PasswordDeleteError:
        pass
    except Exception:
        pass


def read_secret(name: str) -> str | None:
    """Read a secret value from the OS keyring. SDK-only; never exposed via HTTP."""
    try:
        return keyring.get_password(SECRETS_SERVICE, name)
    except Exception:
        return None


def write_secret(name: str, value: str, description: str = "") -> None:
    """Store the value in keyring and upsert the AppSecretRecord metadata."""
    keyring.set_password(SECRETS_SERVICE, name, value)
    existing = AppSecretRecord.get(name)
    if existing is not None:
        existing.description = description
        existing.save()
    else:
        AppSecretRecord(id=name, name=name, description=description).save()


async def delete_secret(name: str) -> None:
    """Remove the keyring value and delete the AppSecretRecord."""
    try:
        keyring.delete_password(SECRETS_SERVICE, name)
    except keyring.errors.PasswordDeleteError:
        pass
    record = AppSecretRecord.get(name)
    if record is not None:
        await record.delete()


def get_secrets() -> list[dict]:
    """List secret metadata. Never reads keyring values."""
    out: list[dict] = []
    for record in AppSecretRecord.discover():
        out.append({
            "name": record.name,
            "description": getattr(record, "description", "") or "",
            "created_at": getattr(record, "created_date", None),
        })
    return out
