#!/usr/bin/env python3
"""Tests for the high-level auth API (set/get/delete/is_logged_in).

Phase C of the InstanceSettings consolidation: credentials live in
``<instance_dir>/sodot``. The ``SERVICE_NAME``/``_api_key_name()``
keychain-coordinates surface is gone — its replacement is
``InstanceSettings.sodot_path`` + ``Flowpad.ai.sod_key/<instance_name>``
for the per-instance Fernet key.
"""

from __future__ import annotations

from flow_sdk.cli.app_config import clear_user, set_user
from flow_sdk.cli.auth.hub_login import (
    delete_api_key,
    get_api_key,
    is_logged_in,
    set_api_key,
)
from flow_sdk.instance_settings import get_instance_settings


def test_auth_keystore(sod_env):
    """Basic set / get / delete + is_logged_in transitions."""
    test_api_key = "test-api-key-12345"

    delete_api_key()
    clear_user()

    assert not is_logged_in()
    assert get_api_key() is None

    set_api_key(test_api_key)
    set_user({"id": "test-user", "email": "test@example.com"})

    assert is_logged_in()
    assert get_api_key() == test_api_key

    delete_api_key()
    clear_user()

    assert not is_logged_in()
    assert get_api_key() is None


def test_sodot_path_is_per_instance(sod_env):
    """Each instance has its own sodot under instances/<name>/sodot."""
    s = get_instance_settings()
    assert s.sodot_path == s.instance_dir / "sodot"
    assert s.instance_name == sod_env.instance_name
    # Writing through the API lands the file at that path.
    set_api_key("k")
    assert s.sodot_path.exists()


def test_delete_nonexistent_key(sod_env):
    """Deleting a non-existent key is a no-op."""
    delete_api_key()
    delete_api_key()
    assert not is_logged_in()
