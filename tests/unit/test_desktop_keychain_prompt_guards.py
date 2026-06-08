from __future__ import annotations

import pytest


def _reset_instance(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")
    monkeypatch.delenv("SOD_ENC_KEY", raising=False)

    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()


def test_desktop_sod_without_signed_handoff_never_calls_keyring(monkeypatch, tmp_path):
    _reset_instance(monkeypatch, tmp_path)

    import keyring
    from flow_sdk.instance_settings import SecretsNotEnabledError, get_instance_settings

    def _boom(*_a, **_k):
        raise AssertionError("Electron desktop backend must not call Python keyring")

    monkeypatch.setattr(keyring, "get_password", _boom)
    monkeypatch.setattr(keyring, "set_password", _boom)

    with pytest.raises(SecretsNotEnabledError):
        get_instance_settings().sod.write("k", "v")


def test_desktop_sod_env_handoff_still_bypasses_keyring(monkeypatch, tmp_path):
    _reset_instance(monkeypatch, tmp_path)

    from cryptography.fernet import Fernet
    import keyring
    from flow_sdk.cli.auth.secrets import is_secrets_enabled
    from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings

    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    reset_instance_settings()

    def _boom(*_a, **_k):
        raise AssertionError("SOD_ENC_KEY must bypass Python keyring")

    monkeypatch.setattr(keyring, "get_password", _boom)
    monkeypatch.setattr(keyring, "set_password", _boom)

    sod = get_instance_settings().sod
    sod.write("k", "v")

    assert sod.read("k") == "v"
    assert is_secrets_enabled() is True


def test_desktop_marker_without_handoff_is_not_enabled_and_does_not_probe(monkeypatch, tmp_path):
    _reset_instance(monkeypatch, tmp_path)

    import keyring
    from flow_sdk.cli.auth.secrets import is_secrets_enabled
    from flow_sdk.instance_settings import get_instance_settings

    def _boom(*_a, **_k):
        raise AssertionError("Desktop is-enabled check must not probe Python keyring")

    monkeypatch.setattr(keyring, "get_password", _boom)

    settings = get_instance_settings()
    settings.instance_dir.mkdir(parents=True, exist_ok=True)
    settings.consent_marker_path.touch()

    assert is_secrets_enabled() is False


def test_desktop_legacy_sod_migration_does_not_touch_keyring(monkeypatch, tmp_path):
    _reset_instance(monkeypatch, tmp_path)

    import keyring
    from flow_sdk.cli.auth.secrets import cleanup_legacy_sod_key, read_legacy_sod_key

    def _boom(*_a, **_k):
        raise AssertionError("Legacy migration must not touch Python keyring in Electron desktop")

    monkeypatch.setattr(keyring, "get_password", _boom)
    monkeypatch.setattr(keyring, "delete_password", _boom)

    assert read_legacy_sod_key() is None
    assert cleanup_legacy_sod_key() is True
