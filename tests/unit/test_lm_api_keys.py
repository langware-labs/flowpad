"""Unit tests for the LM-provider API-key store (flow_sdk.lm_api).

Isolation mirrors tests/unit/test_instance_settings_contract.py: a temp
``FLOW_HOME`` + fresh instance singleton, plus ``SOD_ENC_KEY`` so the encrypted
sod store resolves its Fernet key headlessly (no OS keychain, no consent prompt)
— the same path used inside the fresh-Docker wheel test.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def lm_api(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """Fresh isolated instance with a headless sod key; returns the lm_api module."""
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "lmtest")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())

    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    import flow_sdk.lm_api as mod

    yield mod
    reset_instance_settings()


def test_set_get_round_trip(lm_api) -> None:
    lm_api.set_lm_api("sk-or-test-123", lm_api.LMApiProvider.OPENROUTER)
    assert lm_api.get_lm_api(lm_api.LMApiProvider.OPENROUTER) == "sk-or-test-123"


def test_get_unset_returns_none(lm_api) -> None:
    assert lm_api.get_lm_api(lm_api.LMApiProvider.ANTHROPIC) is None


def test_list_reports_configured_providers_without_values(lm_api) -> None:
    lm_api.set_lm_api("sk-or-1", lm_api.LMApiProvider.OPENROUTER)
    lm_api.set_lm_api("sk-oai-2", lm_api.LMApiProvider.OPENAI)

    listed = lm_api.list_lm_api()
    providers = {r["provider"] for r in listed}
    assert providers == {"openrouter", "openai"}
    assert all(r["configured"] for r in listed)
    # The value must never leak into the list payload.
    blob = str(listed)
    assert "sk-or-1" not in blob and "sk-oai-2" not in blob


def test_set_overwrites(lm_api) -> None:
    lm_api.set_lm_api("first", lm_api.LMApiProvider.OPENROUTER)
    lm_api.set_lm_api("second", lm_api.LMApiProvider.OPENROUTER)
    assert lm_api.get_lm_api(lm_api.LMApiProvider.OPENROUTER) == "second"
    assert len(lm_api.list_lm_api()) == 1


async def test_delete(lm_api) -> None:
    lm_api.set_lm_api("gone-soon", lm_api.LMApiProvider.OPENROUTER)
    await lm_api.delete_lm_api(lm_api.LMApiProvider.OPENROUTER)
    assert lm_api.get_lm_api(lm_api.LMApiProvider.OPENROUTER) is None
    assert lm_api.list_lm_api() == []


def test_string_provider_accepted(lm_api) -> None:
    """The action layer passes a validated enum, but the wrappers also accept the
    wire string form for convenience."""
    lm_api.set_lm_api("sk-str", "openrouter")
    assert lm_api.get_lm_api("openrouter") == "sk-str"
