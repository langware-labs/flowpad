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


def _is_electron_desktop() -> bool:
    return os.environ.get("FLOWPAD_DESKTOP") == "1"


def is_secrets_enabled() -> bool:
    """Non-prompting check: is the per-instance secret store actually
    reachable right now?

    True when ANY of:
      * ``SOD_ENC_KEY`` env supplies the key directly (env ⇒ consent).
      * The in-process ``_sod_key_memo`` was populated (e.g. by
        ``seed_sod_key`` after the signed Electron launcher minted +
        wrote the keychain entry via flow-rs).
      * The consent marker exists AND a Fernet entry actually sits in
        the OS keychain at ``(Flowpad.ai.sod_key, <instance_name>)``.

    In Electron desktop, marker-only state returns False instead of probing
    keychain; the signed launcher must provide ``SOD_ENC_KEY`` or seed the
    in-process memo. Outside Electron, the keychain probe at the end prevents
    the gate from falsely
    claiming "enabled" when the user has deleted the keychain entry
    out-of-band (Keychain Access, ``security delete-generic-password``,
    fresh machine) and left the marker file behind. Without it the
    SecretApprovalDialog redirect in /auth/login_callback would never
    fire, and Python would silently re-mint a new python3.x-owned key
    in the next ``_fetch_or_create_sod_key`` — exactly the failure mode
    reported when ``Flowpad.ai.sod_key`` was deleted but the marker
    survived.
    """
    import os  # noqa: PLC0415

    from flow_sdk.instance_settings.base_settings import (  # noqa: PLC0415
        ENV_SOD_ENC_KEY,
        SOD_KEY_KEYCHAIN_SERVICE,
        _UNSET,
    )

    if os.environ.get(ENV_SOD_ENC_KEY):
        return True

    s = get_instance_settings()
    if getattr(s, "_sod_key_memo", _UNSET) is not _UNSET:
        return True

    if not s.consent_marker_path.exists():
        return False

    if _is_electron_desktop():
        return False

    # Marker present but no env/memo — confirm the keychain entry too.
    try:
        import keyring  # noqa: PLC0415
        return keyring.get_password(SOD_KEY_KEYCHAIN_SERVICE, s.instance_name) is not None
    except Exception:  # noqa: BLE001
        # Keyring unavailable (test env, locked keychain, transient
        # platform error): fall back to trusting the marker so we don't
        # force re-approval on every check under recoverable failures.
        return True


def _consent_previously_granted(settings) -> bool:
    """Prompt-free "was secret storage ever set up here" check.

    Unlike :func:`is_secrets_enabled`, this does NOT probe the keychain —
    so it stays True when the keychain entry was lost but the consent
    marker remains, which is precisely the orphaned-sodot state
    :func:`recover_orphaned_sodot` must be allowed to repair.
    """
    import os  # noqa: PLC0415

    from flow_sdk.instance_settings.base_settings import (  # noqa: PLC0415
        ENV_SOD_ENC_KEY,
        _UNSET,
    )

    if os.environ.get(ENV_SOD_ENC_KEY):
        return True
    if getattr(settings, "_sod_key_memo", _UNSET) is not _UNSET:
        return True
    return settings.consent_marker_path.exists()


def read_legacy_sod_key() -> str | None:
    """Return the Fernet key currently stored at the legacy bare-instance
    keychain slot ``(Flowpad.ai.sod_key, <instance>)`` — the slot Python's
    ``_fetch_or_create_sod_key`` uses — or None if absent.

    In Electron desktop this deliberately returns None: the backend must not
    touch the legacy Python-owned Keychain item. Outside Electron it is
    idempotent and prompt-free in the typical case: Python reads its own
    previously-written entry (same binary identity ⇒ ACL match). Used by
    the one-shot migration flow in /secrets/migrate-to-flow-rs so the
    signed Electron launcher can re-write the SAME key value via the
    bundled flow-rs binary at the ``<instance>.flow-rs`` slot — moving
    the ACL trust list from python3.x to flow-rs without losing the
    sodot file's contents.
    """
    if _is_electron_desktop():
        return None

    import keyring  # noqa: PLC0415

    from flow_sdk.instance_settings.base_settings import SOD_KEY_KEYCHAIN_SERVICE  # noqa: PLC0415

    s = get_instance_settings()
    try:
        return keyring.get_password(SOD_KEY_KEYCHAIN_SERVICE, s.instance_name)
    except Exception:  # noqa: BLE001
        return None


def cleanup_legacy_sod_key() -> bool:
    """Delete the legacy bare-instance keychain entry — called by the
    renderer AFTER a successful migrate-to-flow-rs handoff so the
    python3.x-owned entry doesn't sit orphaned in the keychain. The
    flow-rs-owned entry at ``<instance>.flow-rs`` is the live one from
    this point on; the env handoff (uv-manager.js::_loadSodKey) and the
    seeded memo cover all sod access paths.

    Returns True on success or absent, False on error. In Electron desktop this
    is a no-op because deleting the legacy Python-owned item would itself be a
    backend keychain access.
    """
    if _is_electron_desktop():
        return True

    import keyring  # noqa: PLC0415
    from keyring.errors import PasswordDeleteError  # noqa: PLC0415

    from flow_sdk.instance_settings.base_settings import SOD_KEY_KEYCHAIN_SERVICE  # noqa: PLC0415

    s = get_instance_settings()
    try:
        keyring.delete_password(SOD_KEY_KEYCHAIN_SERVICE, s.instance_name)
        return True
    except PasswordDeleteError:
        # No entry — nothing to clean.
        return True
    except Exception:  # noqa: BLE001
        return False


def seed_sod_key(key: str) -> bool:
    """Install ``key`` as the per-instance Fernet key in memory, bypassing
    the OS keychain entirely.

    Called by the signed Electron launcher via the /secrets/seed-key endpoint
    after Electron has already minted + stored the key in the keychain via
    the bundled ``flow-rs`` binary (so the ACL trust list shows the signed
    flow-rs binary, NOT the unsigned uv-bundled python3.x). This handoff is
    what keeps Python from ever calling ``keyring.set_password`` and ending
    up in the trust list itself.

    Writes the key directly to ``InstanceSettings._sod_key_memo`` (the cache
    field consulted by the ``sod_key`` property), so subsequent .sod access
    uses the seeded value without touching the keychain. Also touches the
    consent marker so ``is_secrets_enabled()`` returns True for any later
    bootstrap probes.

    Idempotent. Returns False if ``key`` is empty; True otherwise.
    """
    if not key:
        return False
    s = get_instance_settings()
    # Bypass the dataclass __setattr__ since BaseInstanceSettings is frozen.
    # The sod_key property checks this attr first and short-circuits.
    object.__setattr__(s, "_sod_key_memo", key.encode())
    try:
        s.instance_dir.mkdir(parents=True, exist_ok=True)
        if not s.consent_marker_path.exists():
            s.consent_marker_path.touch(mode=0o600)
    except OSError:
        return False
    return True


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
        if _is_electron_desktop():
            return is_secrets_enabled()
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

    # No PRIOR consent ⇒ never touch the keychain; nothing to recover.
    # Deliberately NOT is_secrets_enabled(): its trailing keychain probe
    # returns False in exactly the orphan scenario this function exists to
    # fix (entry deleted out-of-band, marker + sodot left behind), which
    # would short-circuit recovery. "Was consent ever granted" is the
    # env-key / in-process-memo / on-disk-marker check, prompt-free.
    if not _consent_previously_granted(settings):
        return None

    if _is_electron_desktop():
        from flow_sdk.instance_settings.base_settings import (  # noqa: PLC0415
            ENV_SOD_ENC_KEY,
            _UNSET,
        )

        if not os.environ.get(ENV_SOD_ENC_KEY) and getattr(settings, "_sod_key_memo", _UNSET) is _UNSET:
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
