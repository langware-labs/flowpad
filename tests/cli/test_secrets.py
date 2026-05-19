"""Tests for app-secret management (flow_sdk.cli.auth.secrets).

Phase C of the InstanceSettings consolidation: secrets live in the
per-instance encrypted sodot file under ``<instance_dir>/sodot`` and the
"is enabled" gate is a separate consent-marker file at
``<instance_dir>/.secrets_enabled``.

The ``sod_env`` fixture (see conftest.py) handles the boilerplate: tmp
FLOW_HOME, unique FLOW_INSTANCE, in-memory keyring for the Fernet key,
and a pre-called ``enable_secrets()`` so the consent gate is open.
"""

from __future__ import annotations

from flow_sdk.cli.auth.secrets import (
    delete_secret,
    disable_secrets,
    enable_secrets,
    get_secrets,
    is_secrets_enabled,
    read_secret,
    write_secret,
)
from flow_sdk.fs_records.app_secret import AppSecretRecord
from flow_sdk.instance_settings import (
    SecretsNotEnabledError,
    get_instance_settings,
    reset_instance_settings,
)


def test_enable_creates_consent_marker(sod_env):
    """After enable_secrets the consent marker file exists and
    is_secrets_enabled returns True."""
    assert is_secrets_enabled() is True
    assert sod_env.consent_marker_path.exists()


def test_disable_removes_consent_marker(sod_env):
    disable_secrets()
    assert is_secrets_enabled() is False
    assert not sod_env.consent_marker_path.exists()


def test_disable_then_enable_round_trip(sod_env):
    disable_secrets()
    assert enable_secrets() is True
    assert is_secrets_enabled() is True


def test_is_enabled_is_false_without_marker(monkeypatch, tmp_path):
    """When no consent has been granted yet, is_secrets_enabled is False —
    and crucially, it does NOT touch the keyring."""
    import uuid

    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", f"unprimed-{uuid.uuid4().hex[:8]}")
    monkeypatch.delenv("FLOWPAD_DEV", raising=False)
    monkeypatch.delenv("FLOWPAD_TEST", raising=False)
    reset_instance_settings()

    # Patch keyring to explode if touched — proves is_secrets_enabled is
    # a pure file probe.
    import keyring

    def explode(*_, **__):
        raise AssertionError("is_secrets_enabled must not touch keyring")

    monkeypatch.setattr(keyring, "get_password", explode)
    monkeypatch.setattr(keyring, "set_password", explode)

    assert is_secrets_enabled() is False


def test_write_read_round_trip(sod_env):
    write_secret("OPENAI_API_KEY", "sk-test-123", "OpenAI key")
    assert read_secret("OPENAI_API_KEY") == "sk-test-123"
    assert read_secret("MISSING") is None
    # Value landed in the per-instance sodot, not in keyring.
    assert get_instance_settings().sod.read("OPENAI_API_KEY") == "sk-test-123"


def test_get_secrets_returns_metadata_only(sod_env):
    write_secret("A_KEY", "secret-a", "Service A")
    write_secret("B_KEY", "secret-b", "Service B")

    listed = get_secrets()
    by_name = {s["name"]: s for s in listed}

    assert set(by_name) == {"A_KEY", "B_KEY"}
    assert by_name["A_KEY"]["description"] == "Service A"
    assert by_name["B_KEY"]["description"] == "Service B"
    for entry in listed:
        assert "value" not in entry
        assert set(entry.keys()) <= {"name", "description", "created_at"}


def test_write_secret_updates_existing(sod_env):
    write_secret("KEY", "old", "old desc")
    write_secret("KEY", "new", "new desc")

    assert read_secret("KEY") == "new"
    listed = [s for s in get_secrets() if s["name"] == "KEY"]
    assert len(listed) == 1
    assert listed[0]["description"] == "new desc"


async def test_delete_secret_removes_value_and_record(sod_env):
    write_secret("DOOMED", "value", "to delete")
    assert read_secret("DOOMED") == "value"
    assert AppSecretRecord.get("DOOMED") is not None

    await delete_secret("DOOMED")

    assert read_secret("DOOMED") is None
    assert get_instance_settings().sod.read("DOOMED") is None
    assert AppSecretRecord.get("DOOMED") is None


async def test_delete_secret_idempotent(sod_env):
    await delete_secret("NEVER_EXISTED")
    await delete_secret("NEVER_EXISTED")


def test_read_secret_without_consent_returns_none(monkeypatch, tmp_path):
    """Reading a secret before consent is granted returns None (does not
    raise) — read is a read-only probe."""
    import uuid

    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", f"unprimed-{uuid.uuid4().hex[:8]}")
    monkeypatch.delenv("FLOWPAD_DEV", raising=False)
    monkeypatch.delenv("FLOWPAD_TEST", raising=False)
    reset_instance_settings()

    assert read_secret("ANYTHING") is None


def test_write_secret_without_consent_raises(monkeypatch, tmp_path):
    """Writing without consent must raise — the consent gate is structural."""
    import uuid

    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", f"unprimed-{uuid.uuid4().hex[:8]}")
    monkeypatch.delenv("FLOWPAD_DEV", raising=False)
    monkeypatch.delenv("FLOWPAD_TEST", raising=False)
    reset_instance_settings()

    # records_root must exist for AppSecretRecord even if we fail before then
    from flow_sdk.fs_store import set_default_records_root
    set_default_records_root(tmp_path / "records")

    import pytest
    with pytest.raises(SecretsNotEnabledError):
        write_secret("ANYTHING", "value")
