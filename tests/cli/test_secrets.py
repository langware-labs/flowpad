"""Tests for app-secret management (flow_sdk.cli.auth.secrets).

Uses an in-memory keyring backend so the user's real OS keychain is never
touched, and a per-test ``records_root`` so AppSecretRecord persistence is
isolated.
"""

from __future__ import annotations

from pathlib import Path

import keyring
import pytest
from keyring.backend import KeyringBackend
from keyring.errors import PasswordDeleteError

from flow_sdk.cli.auth import secrets as secrets_mod
from flow_sdk.cli.auth.secrets import (
    SECRETS_SERVICE,
    SENTINEL_NAME,
    delete_secret,
    enable_secrets,
    get_secrets,
    is_secrets_enabled,
    read_secret,
    write_secret,
)
from flow_sdk.fs_records.app_secret import AppSecretRecord
from flow_sdk.fs_store import set_default_records_root


class _MemKeyring(KeyringBackend):
    """In-memory keyring backend for tests — never touches the OS."""

    priority = 1  # type: ignore[assignment]

    def __init__(self) -> None:
        self.store: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, name: str) -> str | None:
        return self.store.get((service, name))

    def set_password(self, service: str, name: str, password: str) -> None:
        self.store[(service, name)] = password

    def delete_password(self, service: str, name: str) -> None:
        if (service, name) not in self.store:
            raise PasswordDeleteError(f"no entry for {service}/{name}")
        del self.store[(service, name)]


@pytest.fixture
def mem_keyring() -> _MemKeyring:
    """Swap the global keyring backend for an in-memory one for the test."""
    previous = keyring.get_keyring()
    backend = _MemKeyring()
    keyring.set_keyring(backend)
    try:
        yield backend
    finally:
        keyring.set_keyring(previous)


@pytest.fixture
def isolated_records(tmp_path: Path) -> Path:
    """Per-test records_root so AppSecretRecord disk state is fresh."""
    set_default_records_root(tmp_path)
    return tmp_path


def test_enable_then_is_enabled(mem_keyring, isolated_records):
    assert is_secrets_enabled() is False
    assert enable_secrets() is True
    assert is_secrets_enabled() is True
    # Writing the sentinel is what flips the state.
    assert (SECRETS_SERVICE, SENTINEL_NAME) in mem_keyring.store


def test_is_enabled_swallows_backend_errors(monkeypatch, isolated_records):
    """If the keyring backend raises, is_secrets_enabled returns False."""

    def raise_error(*_args, **_kwargs):
        raise RuntimeError("keychain unavailable")

    monkeypatch.setattr(secrets_mod.keyring, "get_password", raise_error)
    assert is_secrets_enabled() is False


def test_write_read_round_trip(mem_keyring, isolated_records):
    write_secret("OPENAI_API_KEY", "sk-test-123", "OpenAI key")
    assert read_secret("OPENAI_API_KEY") == "sk-test-123"
    assert read_secret("MISSING") is None
    # Value is stored under the dedicated app-secrets service, NOT the hub one.
    assert mem_keyring.store[(SECRETS_SERVICE, "OPENAI_API_KEY")] == "sk-test-123"


def test_get_secrets_returns_metadata_only(mem_keyring, isolated_records):
    write_secret("A_KEY", "secret-a", "Service A")
    write_secret("B_KEY", "secret-b", "Service B")

    listed = get_secrets()
    by_name = {s["name"]: s for s in listed}

    assert set(by_name) == {"A_KEY", "B_KEY"}
    assert by_name["A_KEY"]["description"] == "Service A"
    assert by_name["B_KEY"]["description"] == "Service B"
    # No value field is ever returned by the metadata listing.
    for entry in listed:
        assert "value" not in entry
        assert set(entry.keys()) <= {"name", "description", "created_at"}


def test_write_secret_updates_existing(mem_keyring, isolated_records):
    write_secret("KEY", "old", "old desc")
    write_secret("KEY", "new", "new desc")

    assert read_secret("KEY") == "new"
    listed = [s for s in get_secrets() if s["name"] == "KEY"]
    assert len(listed) == 1
    assert listed[0]["description"] == "new desc"


@pytest.mark.asyncio
async def test_delete_secret_removes_keyring_and_record(mem_keyring, isolated_records):
    write_secret("DOOMED", "value", "to delete")
    assert read_secret("DOOMED") == "value"
    assert AppSecretRecord.get("DOOMED") is not None

    await delete_secret("DOOMED")

    assert read_secret("DOOMED") is None
    assert (SECRETS_SERVICE, "DOOMED") not in mem_keyring.store
    assert AppSecretRecord.get("DOOMED") is None


@pytest.mark.asyncio
async def test_delete_secret_idempotent(mem_keyring, isolated_records):
    """Deleting a non-existent secret should not raise."""
    await delete_secret("NEVER_EXISTED")
    # Still no error on second call.
    await delete_secret("NEVER_EXISTED")
