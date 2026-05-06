import json
import time

import pytest

from flow_sdk.cli.app_config import clear_user, set_user
from flow_sdk.cli.auth import credentials as credentials_mod
from flow_sdk.cli.auth.credentials import UserHubCredentials, clear_credentials, load_credentials, save_credentials
from flow_sdk.cli.auth.hub_login import get_api_key, is_logged_in, set_api_key


@pytest.fixture()
def memory_keyring(monkeypatch):
    store: dict[tuple[str, str], str] = {}

    def get_password(service: str, name: str):
        return store.get((service, name))

    def set_password(service: str, name: str, value: str):
        store[(service, name)] = value

    def delete_password(service: str, name: str):
        try:
            del store[(service, name)]
        except KeyError:
            raise credentials_mod.keyring.errors.PasswordDeleteError("missing")

    monkeypatch.setattr(credentials_mod.keyring, "get_password", get_password)
    monkeypatch.setattr(credentials_mod.keyring, "set_password", set_password)
    monkeypatch.setattr(credentials_mod.keyring, "delete_password", delete_password)
    return store


def _key() -> tuple[str, str]:
    return credentials_mod.SERVICE_NAME, credentials_mod._api_key_name()


def test_credentials_round_trip_preserves_fields(memory_keyring):
    creds = UserHubCredentials(
        api_key="token-1",
        expires_at=1234.5,
        refresh_token="refresh-1",
        user={"id": "u1", "email": "u@example.com"},
    )

    save_credentials(creds)

    loaded = load_credentials()
    assert loaded == creds
    assert json.loads(memory_keyring[_key()])["refresh_token"] == "refresh-1"


def test_legacy_raw_key_migrates_on_first_read(memory_keyring):
    memory_keyring[_key()] = "legacy-token"

    loaded = load_credentials()

    assert loaded == UserHubCredentials(api_key="legacy-token")
    assert json.loads(memory_keyring[_key()])["api_key"] == "legacy-token"


def test_set_api_key_compatibility_wrapper(memory_keyring):
    set_api_key("compat-token")

    assert get_api_key() == "compat-token"
    assert load_credentials().api_key == "compat-token"


def test_clear_credentials_is_idempotent(memory_keyring):
    save_credentials(UserHubCredentials(api_key="token-1"))

    clear_credentials()
    clear_credentials()

    assert load_credentials() is None


def test_is_expired_handles_none_and_leeway():
    assert not UserHubCredentials(api_key="token", expires_at=None).is_expired(5)
    assert UserHubCredentials(api_key="token", expires_at=time.time() - 1).is_expired()
    assert UserHubCredentials(api_key="token", expires_at=time.time() + 3).is_expired(5)
    assert not UserHubCredentials(api_key="token", expires_at=time.time() + 30).is_expired(5)


def test_is_logged_in_uses_user_mirror_not_keyring(monkeypatch, memory_keyring):
    def fail_get_password(service: str, name: str):
        raise AssertionError("is_logged_in should not read keyring")

    monkeypatch.setattr(credentials_mod.keyring, "get_password", fail_get_password)

    clear_user()
    assert not is_logged_in()

    set_user({"id": "u1"})
    assert is_logged_in()
    clear_user()
