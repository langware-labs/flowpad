"""Phase B tests — content-addressed singleton + new per-instance properties.

Covers the additions in flow_sdk/instance_settings/{__init__.py,base_settings.py}:
  * _resolve_instance_name_from_env (FLOW_INSTANCE wins; back-compat aliases)
  * _resolve_flow_home_from_env (honors FLOW_HOME)
  * content-addressed get_instance_settings cache
  * instance_dir / sodot_path / consent_marker_path properties
  * sod accessor gated on consent marker
  * one-shot deprecation warnings
"""

from __future__ import annotations

import warnings
from pathlib import Path

import pytest

from flow_sdk.instance_settings import (
    BaseInstanceSettings,
    DevInstanceSettings,
    SecretsNotEnabledError,
    TestInstanceSettings,
    _resolve_flow_home_from_env,
    _resolve_instance_name_from_env,
    get_instance_settings,
    reset_instance_settings,
)
from flow_sdk.instance_settings.base_settings import (
    CONSENT_MARKER_FILENAME,
    SODOT_FILENAME,
)


# ----------------------------------------------------------------------
# Env isolation helper
# ----------------------------------------------------------------------

@pytest.fixture(autouse=True)
def isolate_env(monkeypatch):
    """Each test starts with all instance-related env vars unset and singleton
    cache cleared. Tests that want a specific resolution set their own env.

    NOTE on PYTEST_CURRENT_TEST: pytest re-sets this var per-test AFTER the
    fixture runs, so we can't reliably delenv it. Tests that need to verify
    "default" resolution must set FLOW_INSTANCE=prod explicitly to win over
    the auto-set PYTEST_CURRENT_TEST (FLOW_INSTANCE has highest precedence).
    """
    for k in ("FLOW_INSTANCE", "FLOWPAD_DEV", "FLOWPAD_TEST", "FLOW_HOME", "SOD_KEY"):
        monkeypatch.delenv(k, raising=False)
    reset_instance_settings()
    yield
    reset_instance_settings()


# ----------------------------------------------------------------------
# _resolve_instance_name_from_env
# ----------------------------------------------------------------------

def test_default_is_prod(monkeypatch):
    # PYTEST_CURRENT_TEST is set by pytest — set FLOW_INSTANCE explicitly
    # to verify FLOW_INSTANCE wins over the auto-aliased "test".
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    assert _resolve_instance_name_from_env() == "prod"


def test_flow_instance_wins(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "stage")
    monkeypatch.setenv("FLOWPAD_DEV", "true")
    assert _resolve_instance_name_from_env() == "stage"


def test_flowpad_dev_alias(monkeypatch):
    # PYTEST_CURRENT_TEST takes precedence over FLOWPAD_DEV in the resolver
    # ordering. To verify the dev alias, we need PYTEST_CURRENT_TEST gone.
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setenv("FLOWPAD_DEV", "true")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        assert _resolve_instance_name_from_env() == "dev"
    assert any(issubclass(w.category, DeprecationWarning) for w in caught)


def test_flowpad_test_alias(monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST", "true")
    assert _resolve_instance_name_from_env() == "test"


def test_pytest_current_test_alias(monkeypatch):
    monkeypatch.setenv("PYTEST_CURRENT_TEST", "tests/something.py::test_x")
    assert _resolve_instance_name_from_env() == "test"


def test_test_wins_over_dev(monkeypatch):
    monkeypatch.setenv("FLOWPAD_TEST", "true")
    monkeypatch.setenv("FLOWPAD_DEV", "true")
    assert _resolve_instance_name_from_env() == "test"


def test_deprecation_warning_fires_once(monkeypatch):
    monkeypatch.setenv("FLOWPAD_DEV", "true")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        for _ in range(5):
            _resolve_instance_name_from_env()
    dep_warnings = [w for w in caught if issubclass(w.category, DeprecationWarning)]
    assert len(dep_warnings) == 1, f"expected exactly 1 warning, got {len(dep_warnings)}"


# ----------------------------------------------------------------------
# _resolve_flow_home_from_env
# ----------------------------------------------------------------------

def test_flow_home_default():
    assert _resolve_flow_home_from_env() == Path.home() / ".flow"


def test_flow_home_env_honored(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    assert _resolve_flow_home_from_env() == tmp_path


# ----------------------------------------------------------------------
# Content-addressed singleton
# ----------------------------------------------------------------------

def test_singleton_caches_by_name(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    a = get_instance_settings()
    b = get_instance_settings()
    assert a is b


def test_singleton_switches_on_env_change(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    prod = get_instance_settings()
    monkeypatch.setenv("FLOW_INSTANCE", "dev")
    dev = get_instance_settings()
    assert prod is not dev
    # Switching back returns the original cached instance.
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    assert get_instance_settings() is prod


def test_reset_clears_cache(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    first = get_instance_settings()
    reset_instance_settings()
    second = get_instance_settings()
    assert first is not second


def test_flow_home_affects_cache_key(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "a"))
    a = get_instance_settings()
    monkeypatch.setenv("FLOW_HOME", str(tmp_path / "b"))
    b = get_instance_settings()
    assert a is not b
    assert a.flow_home == tmp_path / "a"
    assert b.flow_home == tmp_path / "b"


# ----------------------------------------------------------------------
# New per-instance properties
# ----------------------------------------------------------------------

def test_instance_dir_path(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    s = get_instance_settings()
    assert s.instance_dir == tmp_path / "instances" / "prod"


def test_sodot_path(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    s = get_instance_settings()
    assert s.sodot_path == tmp_path / "instances" / "prod" / SODOT_FILENAME


def test_consent_marker_path(monkeypatch, tmp_path):
    # Use prod (not test) — TestInstanceSettings overrides _resolve_flow_home
    # to point at a fixed test-isolation dir; FLOW_HOME is only honored by the
    # base/dev resolvers per Phase B scope.
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    s = get_instance_settings()
    assert s.consent_marker_path == tmp_path / "instances" / "prod" / CONSENT_MARKER_FILENAME


# ----------------------------------------------------------------------
# sod accessor — consent gate
# ----------------------------------------------------------------------

def test_sod_raises_without_consent(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    s = get_instance_settings()
    with pytest.raises(SecretsNotEnabledError):
        _ = s.sod


def test_sod_returns_file_sod_storage_with_consent(monkeypatch, tmp_path):
    """With consent marker present + a mocked keychain, sod returns a
    FileSodStorage pointing at sodot_path."""
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")

    # Mock keyring so we don't hit the real OS keychain.
    from cryptography.fernet import Fernet
    fake_key = Fernet.generate_key().decode()
    storage: dict[tuple[str, str], str] = {}

    import keyring
    monkeypatch.setattr(keyring, "get_password",
                        lambda svc, acct: storage.get((svc, acct)))
    monkeypatch.setattr(keyring, "set_password",
                        lambda svc, acct, val: storage.update({(svc, acct): val}))

    s = get_instance_settings()
    s.instance_dir.mkdir(parents=True)
    s.consent_marker_path.touch()

    sod = s.sod
    # Round-trip works
    sod.write("k", "v")
    assert sod.read("k") == "v"
    # File landed at the right place
    assert s.sodot_path.exists()
    # Keychain entry created under the canonical service name
    assert ("Flowpad.ai.sod_key", "prod") in storage


def test_sod_keychain_key_cached_across_calls(monkeypatch, tmp_path):
    """Two `.sod` accesses should hit the keychain exactly once (cache)."""
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")

    from cryptography.fernet import Fernet
    storage: dict[tuple[str, str], str] = {}
    call_count = {"get": 0, "set": 0}

    def _get(svc, acct):
        call_count["get"] += 1
        return storage.get((svc, acct))

    def _set(svc, acct, val):
        call_count["set"] += 1
        storage[(svc, acct)] = val

    import keyring
    monkeypatch.setattr(keyring, "get_password", _get)
    monkeypatch.setattr(keyring, "set_password", _set)

    s = get_instance_settings()
    s.instance_dir.mkdir(parents=True)
    s.consent_marker_path.touch()

    # First access: 1 get (cache miss), 1 set (generate key)
    _ = s.sod
    assert call_count == {"get": 1, "set": 1}

    # Subsequent accesses: no further keychain calls
    for _ in range(5):
        _ = s.sod
    assert call_count == {"get": 1, "set": 1}


# ----------------------------------------------------------------------
# SOD_KEY env bypass — signed Electron launcher hands off the key
# ----------------------------------------------------------------------

def test_sod_env_key_bypasses_keychain(monkeypatch, tmp_path):
    """When SOD_KEY env is set, .sod returns a working storage without
    ever calling keyring, and the consent marker is auto-created."""
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")

    from cryptography.fernet import Fernet
    monkeypatch.setenv("SOD_KEY", Fernet.generate_key().decode())

    call_count = {"get": 0, "set": 0}

    def _boom_get(*_a, **_kw):
        call_count["get"] += 1
        raise AssertionError("keyring.get_password must not be called when SOD_KEY env is set")

    def _boom_set(*_a, **_kw):
        call_count["set"] += 1
        raise AssertionError("keyring.set_password must not be called when SOD_KEY env is set")

    import keyring
    monkeypatch.setattr(keyring, "get_password", _boom_get)
    monkeypatch.setattr(keyring, "set_password", _boom_set)

    s = get_instance_settings()
    assert not s.consent_marker_path.exists()

    sod = s.sod
    sod.write("k", "v")
    assert sod.read("k") == "v"

    # Marker auto-created on first .sod access; keychain never touched.
    assert s.consent_marker_path.exists()
    assert call_count == {"get": 0, "set": 0}


def test_seed_sod_key_populates_cache_and_marker(monkeypatch, tmp_path):
    """seed_sod_key (called from the /secrets/seed-key endpoint after
    Electron has minted + written to the keychain) installs the key in
    the per-process cache, touches the consent marker, and never invokes
    keyring. Subsequent .sod access uses the seeded key."""
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")

    import keyring
    monkeypatch.setattr(keyring, "get_password",
                        lambda *_a, **_k: (_ for _ in ()).throw(
                            AssertionError("keyring.get_password must not be called after seed_sod_key")))
    monkeypatch.setattr(keyring, "set_password",
                        lambda *_a, **_k: (_ for _ in ()).throw(
                            AssertionError("keyring.set_password must not be called after seed_sod_key")))

    from cryptography.fernet import Fernet
    from flow_sdk.cli.auth.secrets import seed_sod_key
    key = Fernet.generate_key().decode()

    s = get_instance_settings()
    assert not s.consent_marker_path.exists()

    assert seed_sod_key(key) is True
    assert s.consent_marker_path.exists()

    # .sod access uses the seeded key — round-trip works without touching keyring.
    sod = s.sod
    sod.write("k", "v")
    assert sod.read("k") == "v"


def test_seed_sod_key_rejects_empty(monkeypatch, tmp_path):
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    from flow_sdk.cli.auth.secrets import seed_sod_key
    assert seed_sod_key("") is False
    s = get_instance_settings()
    assert not s.consent_marker_path.exists()


def test_is_secrets_enabled_true_when_env_set(monkeypatch, tmp_path):
    """SOD_KEY env set => is_secrets_enabled() returns True even with no
    marker file (lets bootstrap proceed to the first .sod access, where
    the marker actually gets touched)."""
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")

    from cryptography.fernet import Fernet
    monkeypatch.setenv("SOD_KEY", Fernet.generate_key().decode())

    from flow_sdk.cli.auth.secrets import is_secrets_enabled
    s = get_instance_settings()
    assert not s.consent_marker_path.exists()
    assert is_secrets_enabled() is True


# ----------------------------------------------------------------------
# Existing dev/test subclasses still work (regression guard)
# ----------------------------------------------------------------------

def test_dev_subclass_still_resolves(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "dev")
    s = get_instance_settings()
    assert isinstance(s, DevInstanceSettings)
    assert s.instance_name == "dev"


def test_test_subclass_still_resolves(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "test")
    s = get_instance_settings()
    assert isinstance(s, TestInstanceSettings)
    assert s.instance_name == "test"


def test_prod_baseclass_resolves(monkeypatch):
    monkeypatch.setenv("FLOW_INSTANCE", "prod")
    s = get_instance_settings()
    assert isinstance(s, BaseInstanceSettings)
    assert s.instance_name == "prod"
