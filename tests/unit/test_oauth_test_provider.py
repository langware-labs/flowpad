"""The env-gated end-to-end provider (`provider_registry._test_providers`)."""

from flow_sdk.core.oauth.provider_registry import (
    TEST_DEVICE,
    TEST_LOOPBACK,
    OAuthFlowKind,
    client_id_for,
    get_local_provider,
    publishable_local_providers,
)


def test_absent_unless_the_test_flag_is_set(monkeypatch):
    monkeypatch.delenv("FLOWPAD_ENABLE_TEST_OAUTH", raising=False)

    assert get_local_provider(TEST_LOOPBACK) is None
    assert TEST_LOOPBACK not in {p.name for p in publishable_local_providers()}


def test_a_publishable_loopback_against_the_dummy_server_when_enabled(monkeypatch):
    monkeypatch.setenv("FLOWPAD_ENABLE_TEST_OAUTH", "1")
    monkeypatch.setenv("DUMMY_OAUTH_BASE_URL", "http://127.0.0.1:7001/")

    provider = get_local_provider(TEST_LOOPBACK)

    assert provider.kind is OAuthFlowKind.LOOPBACK and provider.pkce
    assert provider.endpoints.authorize_url == "http://127.0.0.1:7001/authorize"
    assert provider.probe.url == "http://127.0.0.1:7001/userinfo"
    assert client_id_for(TEST_LOOPBACK) == "dummy-client"
    device = get_local_provider(TEST_DEVICE)
    assert device.kind is OAuthFlowKind.DEVICE
    assert device.endpoints.device_code_url == "http://127.0.0.1:7001/device/code"
    assert {TEST_LOOPBACK, TEST_DEVICE} <= {p.name for p in publishable_local_providers()}
