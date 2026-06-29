"""Routing logic for the SOD key through the vendored, signed flow-rs binary.

Hermetic: the flow-rs subprocess helpers are monkeypatched, so nothing here
shells out or touches a real keychain. Verifies _fetch_or_create_sod_key uses
the <instance>.flow-rs slot, mints when absent, returns an existing key as-is,
and adopts a legacy bare-slot key on first run (migration).
"""

from __future__ import annotations

import keyring
import pytest

import flow_sdk.flow_rs_binary as frb
from flow_sdk.instance_settings.base_settings import (
    SOD_KEY_KEYCHAIN_SERVICE,
    _fetch_or_create_sod_key,
)

INSTANCE = "unit-test-instance"
EXPECTED_ACCOUNT = f"{INSTANCE}{frb.FLOW_RS_ACCOUNT_SUFFIX}"


@pytest.fixture
def signed_path(monkeypatch):
    """Enable the signed-binary path with in-memory get/set spies.

    Returns the dict backing the fake flow-rs restricted store, keyed by
    (service, account).
    """
    store: dict[tuple[str, str], str] = {}

    def fake_get(service, account):
        return store.get((service, account))

    def fake_set(service, account, value):
        store[(service, account)] = value

    monkeypatch.setattr(frb, "vendored_flow_rs_enabled", lambda: True)
    monkeypatch.setattr(frb, "flow_rs_get_restricted", fake_get)
    monkeypatch.setattr(frb, "flow_rs_set_restricted", fake_set)
    monkeypatch.delenv("FLOWPAD_DESKTOP", raising=False)
    # Clear any legacy entry from the shared in-memory keyring backend.
    try:
        keyring.delete_password(SOD_KEY_KEYCHAIN_SERVICE, INSTANCE)
    except Exception:  # noqa: BLE001
        pass
    return store


def test_mints_into_flow_rs_slot_when_absent(signed_path):
    key = _fetch_or_create_sod_key(INSTANCE)

    # Minted into the signed .flow-rs slot, NOT the legacy bare slot.
    assert signed_path[(SOD_KEY_KEYCHAIN_SERVICE, EXPECTED_ACCOUNT)] == key.decode()
    assert (SOD_KEY_KEYCHAIN_SERVICE, INSTANCE) not in signed_path
    # A valid Fernet key round-trips.
    from cryptography.fernet import Fernet

    Fernet(key)


def test_returns_existing_flow_rs_key_without_writing(signed_path):
    signed_path[(SOD_KEY_KEYCHAIN_SERVICE, EXPECTED_ACCOUNT)] = "PREEXISTING_KEY_VALUE"

    key = _fetch_or_create_sod_key(INSTANCE)

    assert key == b"PREEXISTING_KEY_VALUE"
    # Unchanged — no re-mint.
    assert signed_path[(SOD_KEY_KEYCHAIN_SERVICE, EXPECTED_ACCOUNT)] == "PREEXISTING_KEY_VALUE"


def test_migrates_legacy_keyring_key_into_flow_rs_slot(signed_path):
    # Simulate a key previously written by the python keyring path (bare slot).
    keyring.set_password(SOD_KEY_KEYCHAIN_SERVICE, INSTANCE, "LEGACY_PYTHON_KEY")

    key = _fetch_or_create_sod_key(INSTANCE)

    # Same value adopted into the signed slot so the existing sodot still decrypts.
    assert key == b"LEGACY_PYTHON_KEY"
    assert signed_path[(SOD_KEY_KEYCHAIN_SERVICE, EXPECTED_ACCOUNT)] == "LEGACY_PYTHON_KEY"


def test_desktop_mode_refuses_python_keychain(monkeypatch):
    monkeypatch.setenv("FLOWPAD_DESKTOP", "1")
    from flow_sdk.instance_settings import SecretsNotEnabledError

    with pytest.raises(SecretsNotEnabledError):
        _fetch_or_create_sod_key(INSTANCE)


def test_disabled_falls_back_to_keyring(monkeypatch):
    """With the signed path disabled, mint lands in the legacy bare slot."""
    monkeypatch.setattr(frb, "vendored_flow_rs_enabled", lambda: False)
    monkeypatch.delenv("FLOWPAD_DESKTOP", raising=False)
    try:
        keyring.delete_password(SOD_KEY_KEYCHAIN_SERVICE, INSTANCE)
    except Exception:  # noqa: BLE001
        pass

    key = _fetch_or_create_sod_key(INSTANCE)

    assert keyring.get_password(SOD_KEY_KEYCHAIN_SERVICE, INSTANCE) == key.decode()
