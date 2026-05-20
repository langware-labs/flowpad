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

from flow_sdk.fs_records.app_secret import AppSecretRecord
from flow_sdk.instance_settings import (
    SecretsNotEnabledError,
    get_instance_settings,
)
from flow_sdk.instance_settings.base_settings import _fetch_or_create_sod_key


def is_secrets_enabled() -> bool:
    """Non-prompting check: has the user approved keychain access for this
    instance? Pure file probe on the consent marker; never touches the
    keychain or the sod file."""
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
