"""Phase C: credentials storage tests against the per-instance sod.

The legacy ``SERVICE_NAME``/``_api_key_name()`` keyring coordinates are
gone — credentials live as separate sod entries (``api_key``,
``refresh_token``, ``expires_at``, ``user``) under
``<instance_dir>/sodot``.

Uses the shared ``sod_env`` fixture from tests/conftest.py.
"""

from __future__ import annotations

import json
import time
import uuid

import pytest

from flow_sdk.cli.app_config import clear_user, set_user
from flow_sdk.cli.auth.credentials import (
    UserHubCredentials,
    clear_credentials,
    load_credentials,
    save_credentials,
)
from flow_sdk.cli.auth.hub_login import get_api_key, is_logged_in, set_api_key
from flow_sdk.instance_settings import (
    get_instance_settings,
    reset_instance_settings,
)


def test_credentials_round_trip_preserves_fields(sod_env):
    creds = UserHubCredentials(
        api_key="token-1",
        expires_at=1234.5,
        refresh_token="refresh-1",
        user={"id": "u1", "email": "u@example.com"},
    )

    save_credentials(creds)
    loaded = load_credentials()
    assert loaded == creds


def test_credentials_stored_as_separate_sod_entries(sod_env):
    save_credentials(UserHubCredentials(
        api_key="k1",
        refresh_token="r1",
        expires_at=99.0,
        user={"id": "u"},
    ))
    sod = get_instance_settings().sod
    assert sod.read("api_key") == "k1"
    assert sod.read("refresh_token") == "r1"
    assert sod.read("expires_at") == "99.0"
    assert json.loads(sod.read("user")) == {"id": "u"}


def test_save_clears_optional_fields_when_omitted(sod_env):
    """Saving creds without refresh_token/expires_at clears any prior values."""
    save_credentials(UserHubCredentials(
        api_key="k1", refresh_token="r1", expires_at=99.0,
    ))
    save_credentials(UserHubCredentials(api_key="k2"))
    loaded = load_credentials()
    assert loaded is not None
    assert loaded.api_key == "k2"
    assert loaded.refresh_token is None
    assert loaded.expires_at is None


def test_load_returns_none_when_empty(sod_env):
    assert load_credentials() is None


def test_set_api_key_compatibility_wrapper(sod_env):
    set_api_key("compat-token")
    assert get_api_key() == "compat-token"
    assert load_credentials().api_key == "compat-token"


def test_clear_credentials_is_idempotent(sod_env):
    save_credentials(UserHubCredentials(api_key="token-1"))
    clear_credentials()
    clear_credentials()
    assert load_credentials() is None


def test_is_expired_handles_none_and_leeway():
    assert not UserHubCredentials(api_key="token", expires_at=None).is_expired(5)
    assert UserHubCredentials(api_key="token", expires_at=time.time() - 1).is_expired()
    assert UserHubCredentials(api_key="token", expires_at=time.time() + 3).is_expired(5)
    assert not UserHubCredentials(api_key="token", expires_at=time.time() + 30).is_expired(5)


def test_is_logged_in_uses_user_mirror_not_sod(sod_env):
    """is_logged_in must NOT call into instance.sod — it reads the
    file-based user record from app_config so it's safe at startup before
    consent is granted."""
    clear_user()
    assert not is_logged_in()

    set_user({"id": "u1"})
    assert is_logged_in()
    clear_user()


def test_load_credentials_returns_none_without_consent(monkeypatch, tmp_path):
    """When secrets aren't enabled (no consent marker), load_credentials
    must return None rather than raise — it's a read-only probe."""
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", f"unprimed-{uuid.uuid4().hex[:8]}")
    monkeypatch.delenv("FLOWPAD_DEV", raising=False)
    monkeypatch.delenv("FLOWPAD_TEST", raising=False)
    reset_instance_settings()
    assert load_credentials() is None
