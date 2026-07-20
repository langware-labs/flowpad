"""Unit tests for LLM-key validation (flow_sdk.lm_api.validate_lm_api).

The no-key path is deterministic (no network). The real 200/401 provider check is
exercised in browser/manual runs with a live key, not in CI.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def lm_api(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "lmvalidate")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    import flow_sdk.lm_api as mod

    yield mod
    reset_instance_settings()


async def test_validate_no_key_configured(lm_api) -> None:
    result = await lm_api.validate_lm_api(lm_api.LMApiProvider.OPENROUTER)
    assert result == {"valid": False, "message": "No key configured"}


def test_validate_endpoint_table_covers_all_providers() -> None:
    """Every provider must have a validation endpoint, or validate_lm_api KeyErrors
    on a configured key."""
    from flow_sdk.cli.auth.lm_api_keys import _VALIDATE_ENDPOINTS
    from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider

    for provider in LMApiProvider:
        assert provider.value in _VALIDATE_ENDPOINTS, f"no validate endpoint for {provider.value}"
        url, build_headers = _VALIDATE_ENDPOINTS[provider.value]
        assert url.startswith("https://")
        # The header builder must embed the key.
        assert any("SENTINEL" in v for v in build_headers("SENTINEL").values())


async def test_validate_string_provider(lm_api) -> None:
    result = await lm_api.validate_lm_api("anthropic")
    assert result["valid"] is False  # no key stored → deterministic, no network
