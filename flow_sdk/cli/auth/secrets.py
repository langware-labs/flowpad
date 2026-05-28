"""Per-instance app-secret storage.

Secret values live in the per-instance encrypted ``sodot`` file (see
``flow_sdk/instance_settings``). Secret metadata (name, description) lives
in ``AppSecretRecord`` in the fs_store. Reading a secret value goes
through ``read_secret`` only — never exposed via HTTP.

The "consent gate" — whether the user has approved keychain access for
this instance — is a separate concept from the sod file's contents:

* :func:`is_secrets_enabled` is a pure file probe on the consent marker
  (``<instance_dir>/.secrets_enabled``). Never touches the keychain.
* :func:`enable_secrets` writes the consent marker AFTER triggering the
  OS keychain prompt (via the Fernet key fetch in
  ``_fetch_or_create_sod_key``). This is the single structural point where
  the prompt can fire on a fresh instance.

Phase C of the InstanceSettings consolidation. The legacy keychain
``Flowpad.ai.app_secrets`` entries are no longer read or written here.
"""

from __future__ import annotations

import logging
import os

from flow_sdk.fs_records.app_secret import AppSecretRecord
from flow_sdk.instance_settings import (
    SecretsNotEnabledError,
    get_instance_settings,
)
from flow_sdk.instance_settings.base_settings import ENV_SOD_KEY, _fetch_or_create_sod_key


def is_secrets_enabled() -> bool:
    """Non-prompting check: has the user approved keychain access for this
    instance? Pure file probe on the consent marker; never touches the
    keychain or the sod file.

    When ``SOD_KEY`` is provided in the environment (signed Electron
    launcher), the env-provision itself counts as enabled — the consent
    marker is auto-created on first ``.sod`` access. Returning True here
    is what lets ``bootstrap.py`` proceed to that first access on launch."""
    if os.environ.get(ENV_SOD_KEY):
        return True
    return get_instance_settings().consent_marker_path.exists()


def enable_secrets() -> bool:
    """Trigger the single OS keychain prompt and record consent.

    Bypasses the ``InstanceSettings.sod`` accessor (which gates on the
    consent marker we're about to create).

    **Idempotent and keychain-free when already enabled.** If the consent
    marker already exists we short-circuit immediately, never touching
    the keychain. This matters in two cases:

      1. Defensive call sites (e.g. ``cloud_login._finalize_login``) that
         call this before every save — under the old design they would
         re-prompt the OS keychain on every login.
      2. Recovery from an interrupted enable: if the keychain key was
         already written but the consent marker write was interrupted,
         a second call re-uses the cached key via ``_SOD_KEY_CACHE`` and
         only touches the marker.

    Returns True on success, False if the keychain step raised.
    """
    s = get_instance_settings()
    if s.consent_marker_path.exists():
        return True
    s.instance_dir.mkdir(parents=True, exist_ok=True)
    try:
        _fetch_or_create_sod_key(s.instance_name)
    except Exception:
        return False
    s.consent_marker_path.touch(mode=0o600)
    return True


def disable_secrets() -> None:
    """Remove the consent marker. Idempotent. Does NOT delete the keychain
    Fernet key or the sodot file — that's a manual cleanup so users don't
    lose secrets from a misclick."""
    get_instance_settings().consent_marker_path.unlink(missing_ok=True)


def read_secret(name: str) -> str | None:
    """Read a secret value from the per-instance sod. SDK-only; never
    exposed via HTTP. Returns None when secrets aren't enabled."""
    try:
        return get_instance_settings().sod.read(name)
    except SecretsNotEnabledError:
        return None


def write_secret(name: str, value: str, description: str = "") -> None:
    """Store the value in the per-instance sod and upsert the
    AppSecretRecord metadata. Requires consent to have been granted —
    raises :class:`SecretsNotEnabledError` otherwise."""
    get_instance_settings().sod.write(name, value)
    existing = AppSecretRecord.get(name)
    if existing is not None:
        existing.description = description
        existing.save()
    else:
        AppSecretRecord(id=name, name=name, description=description).save()


async def delete_secret(name: str) -> None:
    """Remove the sod entry and delete the AppSecretRecord."""
    try:
        get_instance_settings().sod.delete(name)
    except SecretsNotEnabledError:
        pass
    record = AppSecretRecord.get(name)
    if record is not None:
        await record.delete()


def get_secrets() -> list[dict]:
    """List secret metadata. Never reads sod values."""
    out: list[dict] = []
    for record in AppSecretRecord.discover():
        out.append({
            "name": record.name,
            "description": getattr(record, "description", "") or "",
            "created_at": getattr(record, "created_date", None),
        })
    return out


def recover_orphaned_sodot() -> dict | None:
    """Detect and recover from an undecryptable per-instance secrets file.

    The ``sodot`` file is encrypted with a Fernet key kept in the OS keychain
    (``Flowpad.ai.sod_key`` / instance name). If that key goes missing — e.g.
    the user migrated machines and copied ``~/.flow`` but not the keychain, the
    keychain was reset, or the entry was deleted — ``_fetch_or_create_sod_key``
    silently mints a *new* key. The existing ``sodot`` then can no longer be
    decrypted, every secret read raises ``InvalidToken``, and because writes are
    read-modify-write even re-login fails. The secrets are unrecoverable, so the
    only clean fix is to delete the stale ``sodot`` and start fresh.

    This runs only when consent was previously granted (the consent marker
    exists) — it never triggers a first-time keychain prompt. When the file
    decrypts fine, it's a no-op.

    Returns a UI notice dict when a reset was performed, else None. Synchronous
    (file IO + keychain + login-record reset); call via ``asyncio.to_thread``.
    """
    settings = get_instance_settings()

    # No consent ⇒ never touch the keychain; nothing to recover.
    if not is_secrets_enabled():
        return None

    sodot_path = settings.sodot_path
    if not sodot_path.exists():
        return None

    # Probe: accessing `.sod` mints a fresh key if the keychain entry is gone,
    # then `.list()` forces a decrypt of the existing file. A healthy file
    # decrypts cleanly; an orphaned one raises InvalidToken (or similar).
    try:
        settings.sod.list()
        return None  # decrypts fine → healthy, leave it alone
    except SecretsNotEnabledError:
        return None  # consent was revoked between the check and here
    except Exception as decrypt_error:
        logging.warning(
            f"[secrets] sodot at {sodot_path} no longer decrypts "
            f"({type(decrypt_error).__name__}); the keychain key was lost or "
            f"changed. Resetting secrets so login/secret entry can start clean."
        )

    # Delete the stale secrets file and its lock sibling.
    lock_path = sodot_path.with_suffix(".lock")
    for path in (sodot_path, lock_path):
        try:
            path.unlink(missing_ok=True)
        except OSError as e:
            logging.warning(f"[secrets] Failed to delete {path} during sodot recovery: {e}")

    # The stored hub token is gone with the file — clear the file-based login
    # record so the UI reflects logged-out state instead of a phantom session.
    try:
        from flow_sdk.cli.app_config import set_user  # noqa: PLC0415
        set_user({})
    except Exception as e:
        logging.warning(f"[secrets] Failed to clear user record during sodot recovery: {e}")

    return {
        "id": "secrets-reset",
        "level": "warning",
        "title": "Saved secrets were reset",
        "message": (
            "We couldn't unlock your saved secrets — the encryption key in your "
            "system keychain was changed or removed (this can happen after "
            "migrating to a new machine or resetting the keychain). Your stored "
            "login and API keys have been cleared. Please sign in again and "
            "re-enter any API keys."
        ),
    }


async def clear_app_secret_metadata() -> None:
    """Delete all AppSecretRecord metadata after a sodot reset.

    The secret *values* lived in the now-deleted sodot; the metadata records
    (name/description) live separately in the fs_store. Without this the
    secrets list would show entries whose values are gone. Idempotent — safe
    to call when there are no records. Best-effort: a failure to delete one
    record is logged and skipped rather than aborting recovery.
    """
    for record in AppSecretRecord.discover():
        try:
            await record.delete()
        except Exception as e:
            logging.warning(
                f"[secrets] Failed to delete app-secret record "
                f"{getattr(record, 'name', '?')!r} during recovery: {e}"
            )
