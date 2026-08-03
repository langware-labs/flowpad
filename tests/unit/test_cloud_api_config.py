from flow_sdk.cloud_client import ApiConfig


def test_hub_app_url_is_derived_from_api_base(monkeypatch):
    monkeypatch.delenv("FLOWPAD_HUB_WEB_URL", raising=False)

    config = ApiConfig(api_base_url="https://hub.flowpad.ai/api/v1/")

    assert config.app_base_url == "https://hub.flowpad.ai"


def test_hub_app_url_can_differ_from_api_origin(monkeypatch):
    monkeypatch.setenv("FLOWPAD_HUB_WEB_URL", "http://localhost:4098/")

    config = ApiConfig(api_base_url="http://localhost:8093/api/v1")

    assert config.app_base_url == "http://localhost:4098"
