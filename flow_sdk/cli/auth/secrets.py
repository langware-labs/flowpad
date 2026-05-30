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

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_types import RecordType


def _get_app_secret(name: str) -> FSRecord | None:
    try:
        return FSRecord.load(RecordType.APP_SECRET, name)
    except FileNotFoundError:
        return None


def _list_app_secrets() -> list[FSRecord]:
    """List all app_secret FSRecords by scanning the shadow root."""
    return FSRecord.discover(str(RecordType.APP_SECRET))
from flow_sdk.instance_settings import (
    SecretsNotEnabledError,
    get_instance_settings,
)


def is_secrets_enabled() -> bool:
    """Non-prompting check: is the per-instance secret store set up?

    True when ``SOD_ENC_KEY`` is supplied (env key ⇒ consent, no keychain) OR
    the consent marker exists. Pure env+file probe; never touches the keychain
    or decrypts the sod file. The marker is now auto-created on first secret
    use (see ``InstanceSettings.sod_key``), decoupled from cloud login.
    """
    import os  # noqa: PLC0415

    from flow_sdk.instance_settings.base_settings import ENV_SOD_ENC_KEY  # noqa: PLC0415

    if os.environ.get(ENV_SOD_ENC_KEY):
        return True
    return get_instance_settings().consent_marker_path.exists()


def enable_secrets() -> bool:
    """Pre-warm the per-instance secret store at a controlled moment (e.g.
    behind the keychain-approval dialog) and record the consent sentinel.

    No longer a precondition — ``instance.sod`` is always available and
    auto-creates the marker on first use. This simply resolves the key now
    (the single keychain prompt) so later access is silent, and ensures the
    ``.secrets_enabled`` marker exists. Routed through ``instance.sod_key`` so
    it shares the one per-process memo (no extra keychain hit).

    **Idempotent and keychain-free when already enabled.** Returns True on
    success, False if the keychain step raised.
    """
    s = get_instance_settings()
    if s.consent_marker_path.exists():
        return True
    try:
        _ = s.sod_key  # resolves env/keychain, memoizes, auto-creates marker on mint
    except Exception:
        return False
    # Ensure the marker for the env-key path too (sod_key only writes it on a
    # keychain mint, not when SOD_ENC_KEY supplied the key).
    try:
        s.instance_dir.mkdir(parents=True, exist_ok=True)
        if not s.consent_marker_path.exists():
            s.consent_marker_path.touch(mode=0o600)
    except OSError:
        return False
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
    """Store the value in the per-instance sod and upsert the app_secret
    FSRecord metadata. Requires consent to have been granted — raises
    :class:`SecretsNotEnabledError` otherwise."""
    get_instance_settings().sod.write(name, value)
    existing = _get_app_secret(name)
    if existing is not None:
        existing.__dict__["description"] = description
        existing.save()
    else:
        FSRecord(type=RecordType.APP_SECRET, id=name, name=name, description=description).save()


async def delete_secret(name: str) -> None:
    """Remove the sod entry and delete the app_secret FSRecord shadow."""
    try:
        get_instance_settings().sod.delete(name)
    except SecretsNotEnabledError:
        pass
    record = _get_app_secret(name)
    if record is not None:
        import shutil
        try:
            shutil.rmtree(record.shadow_dir)
        except OSError:
            pass


def get_secrets() -> list[dict]:
    """List secret metadata. Never reads sod values."""
    out: list[dict] = []
    for record in _list_app_secrets():
        out.append({
            "name": record.__dict__.get("name"),
            "description": record.__dict__.get("description") or "",
            "created_at": record.__dict__.get("created_date"),
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

    # Probe: `.list()` forces a decrypt of the existing file. Only a GENUINE
    # decrypt failure (wrong/lost key → InvalidToken) means the file is
    # unrecoverable and may be reset. A keychain-ACCESS error (locked / denied)
    # is TRANSIENT — the key is intact, it just can't be read right now —
    # so it must NEVER trigger the destructive reset (see the 2026-05-30 prod
    # logout: a momentarily-locked keychain raised KeyringLocked and the old
    # broad `except` wiped the whole sodot).
    from cryptography.fernet import InvalidToken  # noqa: PLC0415
    from keyring.errors import KeyringError  # noqa: PLC0415 — KeyringLocked subclasses this

    try:
        settings.sod.list()
        return None  # decrypts fine → healthy, leave it alone
    except SecretsNotEnabledError:
        return None  # consent was revoked between the check and here
    except KeyringError as e:
        # Keychain locked / access denied — transient. Do NOT delete anything.
        logging.warning(
            f"[secrets] keychain unavailable while probing sodot at {sodot_path} "
            f"({type(e).__name__}); NOT resetting — unlock the keychain and retry."
        )
        return None
    except InvalidToken:
        # Genuine: the Fernet key truly changed/was lost, so the existing sodot
        # can never be decrypted. Reset is the only clean fix.
        logging.warning(
            f"[secrets] sodot at {sodot_path} no longer decrypts (InvalidToken); "
            f"the keychain key was lost or changed. Resetting secrets so "
            f"login/secret entry can start clean."
        )
    except Exception as unexpected:
        # Unknown failure — do NOT delete on a guess; surface and bail.
        logging.warning(
            f"[secrets] unexpected error probing sodot at {sodot_path} "
            f"({type(unexpected).__name__}); NOT resetting."
        )
        return None

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
            "login, API keys, and connected integrations (e.g. GitHub, MCP "
            "servers) have been cleared. Please sign in again and reconnect any "
            "integrations."
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
    import shutil

    for record in _list_app_secrets():
        try:
            shutil.rmtree(record.shadow_dir)
        except Exception as e:
            logging.warning(
                f"[secrets] Failed to delete app-secret record "
                f"{record.__dict__.get('name', '?')!r} during recovery: {e}"
            )
