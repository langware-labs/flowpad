"""Unit tests for user-editable model mapping (Capability.model_map override layer).

Resolution is deterministic and offline (no worker spawn, no network). The model
catalog fetch (list_provider_models) is a real network call, exercised manually.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "modelmap")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    yield
    reset_instance_settings()


@pytest.fixture(autouse=True)
async def _reset_harness_auth_mode():
    """Reset harness Capabilities to device auth after each test — ``_set_harness``
    persists ``auth_mode="api"`` into the shared session DB, which otherwise makes
    later worker-spawning tests fail with "set to API-key auth but no key"."""
    yield
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability

    for worker in ("claude", "codex", "copilot"):
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        if cap is not None and getattr(cap, "auth_mode", "device") != "device":
            cap.auth_mode = "device"
            cap.api_provider = None
            cap.model_map = {}
            await cap.save(notify=False)


def _proc(worker_type: str, model: str | None):
    return SimpleNamespace(driver=SimpleNamespace(name=worker_type), cli_config={"model": model})


async def _set_harness(worker: str, *, provider="openrouter", model_map=None) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        worker_capability_kind,
    )
    from flow_sdk.builtin.capability import Capability

    cap = await Capability.get_by_kind(worker_capability_kind(worker))
    cap.auth_mode = "api"
    cap.api_provider = provider
    cap.model_map = model_map or {}
    await cap.save(notify=False)


async def test_override_replaces_tier_default(env) -> None:
    from flow_sdk.lm_api import set_lm_api, LMApiProvider
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness("claude", model_map={"openrouter": {"sm": "z-ai/glm-4.6"}})

    auth = await resolve_worker_api_auth(_proc("claude", "sm"))
    assert auth.model_slug == "z-ai/glm-4.6"  # override wins over the haiku default


async def test_custom_named_entry_resolves(env) -> None:
    from flow_sdk.lm_api import set_lm_api, LMApiProvider
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness("claude", model_map={"openrouter": {"coding": "z-ai/glm-4.6"}})

    auth = await resolve_worker_api_auth(_proc("claude", "coding"))
    assert auth.model_slug == "z-ai/glm-4.6"


async def test_unmapped_tier_falls_back_to_spec(env) -> None:
    from flow_sdk.lm_api import set_lm_api, LMApiProvider
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    # Override only sm; md must still resolve to the spec default.
    await _set_harness("claude", model_map={"openrouter": {"sm": "z-ai/glm-4.6"}})

    auth = await resolve_worker_api_auth(_proc("claude", "md"))
    assert auth.model_slug == "anthropic/claude-sonnet-4.5"


async def test_override_scoped_per_provider(env) -> None:
    from flow_sdk.lm_api import set_lm_api, LMApiProvider
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    # An override under a DIFFERENT provider must not apply to openrouter.
    await _set_harness("claude", provider="openrouter", model_map={"anthropic": {"sm": "x/y"}})

    auth = await resolve_worker_api_auth(_proc("claude", "sm"))
    assert auth.model_slug == "anthropic/claude-haiku-4.5"  # spec default, not the anthropic override


def test_models_endpoint_table_covers_all_providers() -> None:
    from flow_sdk.cli.auth.lm_api_keys import _MODELS_ENDPOINTS
    from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider

    for provider in LMApiProvider:
        assert provider.value in _MODELS_ENDPOINTS
        url, needs_key = _MODELS_ENDPOINTS[provider.value]
        assert url.startswith("https://")
        assert isinstance(needs_key, bool)
    # OpenRouter's catalog is public.
    assert _MODELS_ENDPOINTS[LMApiProvider.OPENROUTER.value][1] is False
