"""Tests for bootstrap's orphaned-sodot recovery.

When the per-instance Fernet key in the OS keychain is lost or changed (e.g.
machine migration, keychain reset, deleted entry), the existing encrypted
``sodot`` file can no longer be decrypted — and ``_fetch_or_create_sod_key``
silently mints a fresh key, leaving the file permanently unreadable.
``recover_orphaned_sodot`` detects this, deletes the stale file, clears the
login record, and returns a UI notice. See
``flow_sdk/server/routes/bootstrap.py``.

The ``sod_env`` fixture (see conftest.py) handles the boilerplate: tmp
FLOW_HOME, unique FLOW_INSTANCE, in-memory keyring for the Fernet key, and a
pre-called ``enable_secrets()`` so the consent gate is open.
"""

from __future__ import annotations

import keyring

from flow_sdk.cli.auth.secrets import (
    clear_app_secret_metadata,
    recover_orphaned_sodot,
    write_secret,
)
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import reset_instance_settings
from flow_sdk.instance_settings.base_settings import SOD_KEY_KEYCHAIN_SERVICE


def _lose_keychain_key(instance_name: str) -> None:
    """Simulate the keychain Fernet key going missing across a restart: drop
    the keychain entry and reset the instance cache so the next sod access
    re-resolves on a fresh instance (no memoized key) and mints a new
    (mismatched) key — exactly what a real restart would do."""
    try:
        keyring.delete_password(SOD_KEY_KEYCHAIN_SERVICE, instance_name)
    except Exception:
        pass
    reset_instance_settings()


def test_healthy_sodot_is_left_alone(sod_env):
    """A decryptable sodot is healthy — recovery is a no-op."""
    write_secret("OPENAI_API_KEY", "sk-test-123")
    assert sod_env.sodot_path.exists()

    assert recover_orphaned_sodot() is None
    assert sod_env.sodot_path.exists()
    assert sod_env.sod.read("OPENAI_API_KEY") == "sk-test-123"


def test_orphaned_sodot_is_reset_with_notice(sod_env):
    """When the keychain key is lost, the undecryptable sodot is deleted and a
    friendly notice is returned."""
    write_secret("OPENAI_API_KEY", "sk-test-123")
    assert sod_env.sodot_path.exists()

    _lose_keychain_key(sod_env.instance_name)

    notice = recover_orphaned_sodot()
    assert notice is not None
    assert notice["id"] == "secrets-reset"
    assert notice["level"] == "warning"
    assert notice["title"]
    assert notice["message"]

    # Stale file deleted; subsequent reads start clean (no decrypt error).
    assert not sod_env.sodot_path.exists()
    assert sod_env.sod.read("OPENAI_API_KEY") is None


def test_keyring_locked_does_not_reset_sodot(sod_env, monkeypatch):
    """A TRANSIENT keychain lock (KeyringLocked) must NOT wipe the sodot.

    Regression for the 2026-05-30 prod logout: a momentarily-locked keychain
    raised KeyringLocked during boot recovery and the old broad `except`
    destroyed the whole store. The key is intact — unlocking recovers it — so
    recovery must leave everything in place.
    """
    import keyring
    import keyring.errors as kerr

    write_secret("OPENAI_API_KEY", "sk-test-123")
    assert sod_env.sodot_path.exists()

    # Drop the per-instance key memo so the next access re-reads the keychain,
    # and make that read report the keychain as LOCKED.
    monkeypatch.delenv("SOD_ENC_KEY", raising=False)
    reset_instance_settings()

    def _locked(*_a, **_k):
        raise kerr.KeyringLocked("keychain is locked")

    monkeypatch.setattr(keyring, "get_password", _locked)

    notice = recover_orphaned_sodot()

    assert notice is None                       # transient → no reset, no notice
    assert sod_env.sodot_path.exists()          # sodot must survive intact
    assert sod_env.sodot_path.stat().st_size > 0


async def test_clear_app_secret_metadata_removes_orphaned_records(sod_env):
    """After a sodot reset, the now-orphaned metadata records are deleted so
    the secrets list doesn't show entries whose values are gone."""
    write_secret("OPENAI_API_KEY", "sk-test-123", "OpenAI key")
    write_secret("GROQ_API_KEY", "gsk-test", "Groq key")
    assert FSRecord.load_or_none(RecordType.APP_SECRET, "OPENAI_API_KEY") is not None
    assert FSRecord.load_or_none(RecordType.APP_SECRET, "GROQ_API_KEY") is not None

    _lose_keychain_key(sod_env.instance_name)

    assert recover_orphaned_sodot() is not None
    await clear_app_secret_metadata()

    assert FSRecord.load_or_none(RecordType.APP_SECRET, "OPENAI_API_KEY") is None
    assert FSRecord.load_or_none(RecordType.APP_SECRET, "GROQ_API_KEY") is None
    assert FSRecord.discover(str(RecordType.APP_SECRET)) == []


async def test_clear_app_secret_metadata_is_idempotent(sod_env):
    """No records ⇒ no-op, no raise."""
    await clear_app_secret_metadata()
    await clear_app_secret_metadata()


def test_no_sodot_file_is_noop(sod_env):
    """Consent granted but nothing written yet — nothing to recover."""
    assert not sod_env.sodot_path.exists()
    assert recover_orphaned_sodot() is None


def test_no_consent_never_touches_keychain(monkeypatch, tmp_path):
    """Without consent, recovery returns None without reading the keychain."""
    import uuid

    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", f"unprimed-{uuid.uuid4().hex[:8]}")
    monkeypatch.delenv("FLOWPAD_DEV", raising=False)
    monkeypatch.delenv("FLOWPAD_TEST", raising=False)
    reset_instance_settings()

    def explode(*_, **__):
        raise AssertionError("recovery must not touch keyring without consent")

    monkeypatch.setattr(keyring, "get_password", explode)
    monkeypatch.setattr(keyring, "set_password", explode)

    assert recover_orphaned_sodot() is None
