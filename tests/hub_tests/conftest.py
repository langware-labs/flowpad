"""Fixtures for tests that require a real local Flowpad hub."""

from __future__ import annotations

import os
from urllib.parse import urlparse

import httpx
import pytest


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
_LOCAL_HUB_STATUS: tuple[bool, str] | None = None


def _configured_hub_base_url() -> str:
    env_url = os.environ.get("FLOWPAD_HUB_URL")
    if env_url:
        return env_url.rstrip("/")

    from flow_sdk.config import default_service_config

    return (default_service_config.flowpad_hub_url or "").rstrip("/")


def _check_local_hub_available(base_url: str) -> tuple[bool, str]:
    if not base_url:
        return False, "FLOWPAD_HUB_URL is not configured"

    parsed = urlparse(base_url)
    if parsed.hostname not in LOCAL_HOSTS:
        return False, f"configured hub is not local: {base_url}"

    health_url = f"{base_url}/api/v1/health/status"
    try:
        response = httpx.get(health_url, timeout=2.0)
    except Exception as e:
        return False, f"local hub is not reachable at {health_url}: {e}"

    if response.status_code < 200 or response.status_code >= 300:
        return False, f"local hub health check failed with HTTP {response.status_code}"

    return True, ""


def _local_hub_status() -> tuple[bool, str]:
    global _LOCAL_HUB_STATUS
    if _LOCAL_HUB_STATUS is None:
        _LOCAL_HUB_STATUS = _check_local_hub_available(_configured_hub_base_url())
    return _LOCAL_HUB_STATUS


def pytest_collection_modifyitems(items):
    ok, reason = _local_hub_status()
    if ok:
        return
    skip_hub = pytest.mark.skip(reason=reason)
    for item in items:
        if "hub_tests" in str(item.path):
            item.add_marker(skip_hub)


@pytest.fixture(scope="session")
def hub_base_url() -> str:
    return _configured_hub_base_url()


@pytest.fixture(scope="session", autouse=True)
def local_hub_available(hub_base_url):
    ok, reason = _local_hub_status()
    if not ok:
        pytest.skip(reason)
    return True


@pytest.fixture(autouse=True)
def configure_desktop_hub(hub_base_url):
    from flow_sdk.config import default_service_config

    old = default_service_config.flowpad_hub_url
    default_service_config.flowpad_hub_url = hub_base_url
    yield
    default_service_config.flowpad_hub_url = old


@pytest.fixture(autouse=True)
def isolated_hub_keyring(monkeypatch):
    """Per-test in-memory keyring with isolated per-instance sod state.

    Phase C+D: credentials no longer live in keyring directly — they live
    in the per-instance encrypted sodot file, with only the Fernet key in
    keyring. This fixture mirrors the shared ``sod_env`` pattern (see
    tests/conftest.py): unique FLOW_INSTANCE per test, monkeypatched
    keyring, consent gate opened via ``enable_secrets()``.

    The root tests/conftest.py registers a process-wide in-memory keyring
    backend before any flow_sdk import, so even if a test bypassed this
    fixture the real OS keychain would still be unreachable.
    """
    import keyring
    import keyring.errors
    import uuid as _uuid

    instance_name = f"test-{_uuid.uuid4().hex[:8]}"
    monkeypatch.setenv("FLOW_INSTANCE", instance_name)

    from flow_sdk.instance_settings import reset_instance_settings
    reset_instance_settings()

    store: dict[tuple[str, str], str] = {}

    def get_password(service: str, name: str):
        return store.get((service, name))

    def set_password(service: str, name: str, value: str):
        store[(service, name)] = value

    def delete_password(service: str, name: str):
        if (service, name) not in store:
            raise keyring.errors.PasswordDeleteError("missing")
        del store[(service, name)]

    monkeypatch.setattr(keyring, "get_password", get_password)
    monkeypatch.setattr(keyring, "set_password", set_password)
    monkeypatch.setattr(keyring, "delete_password", delete_password)

    from flow_sdk.cli.auth.secrets import enable_secrets
    enable_secrets()

    yield store
    reset_instance_settings()


def _login(hub_base_url: str, *, expires_in_seconds: int | None = None) -> dict:
    email = os.environ.get("FLOWPAD_CLOUD_USER_EMAIL")
    password = os.environ.get("FLOWPAD_CLOUD_USER_PASSWORD")

    with httpx.Client(base_url=f"{hub_base_url}/api/v1", timeout=10.0) as client:
        if email and password:
            payload = {"email": email, "password": password}
            if expires_in_seconds is not None:
                payload["expires_in_seconds"] = expires_in_seconds
            response = client.post("/login", json=payload)
        else:
            params = {}
            if expires_in_seconds is not None:
                params["expires_in_seconds"] = str(expires_in_seconds)
            response = client.post("/login/local", params=params)

    if response.status_code != 200:
        pytest.skip(f"local hub login failed with HTTP {response.status_code}: {response.text[:300]}")

    body = response.json()
    if body.get("status") not in ("SUCCESS", "success"):
        pytest.skip(f"local hub login failed: {body}")
    return body["data"]


@pytest.fixture()
def hub_login_payload(hub_base_url) -> dict:
    return _login(hub_base_url)


@pytest.fixture()
def short_lived_hub_login_payload(hub_base_url) -> dict:
    return _login(hub_base_url, expires_in_seconds=5)
