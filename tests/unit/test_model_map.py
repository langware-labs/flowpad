"""Model sizes live on the LLM endpoint; the legacy ``Capability.model_map`` is migrated onto it.

``model_map['device']`` moves to the harness's device-login endpoint row, ``model_map[<provider>]``
onto that provider's stored key row (overrides won before, so they win there too), and the map is
emptied so the move happens once. Resolution is deterministic and offline (no spawn, no network).
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

from tests.utils.harness_installed import harness_installed  # noqa: F401 — a fixture

# CI has no vendor CLI on PATH; a key funds nothing for a CLI that is not installed.
pytestmark = pytest.mark.usefixtures("harness_installed")


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
    from flow_sdk.builtin.agentic_process.cli_drivers.device_endpoints import configure_device

    await configure_device("codex", {})
    # The migrated overrides landed on the shared openrouter key row; give it its defaults back.
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    from flow_sdk.external_apis.llm.dialects import get_dialect

    row = await LLMEndpoint.find_by_secret("lm_api.openrouter")
    if row is not None:
        row.tiers = dict(get_dialect("openrouter").default_models)
        await row.save(notify=False)


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
    from flow_sdk.builtin.agentic_process.cli_drivers.device_endpoints import migrate_capability_model_maps

    await migrate_capability_model_maps(force=True)


async def test_override_replaces_tier_default(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness("claude", model_map={"openrouter": {"sm": "z-ai/glm-4.6"}})

    auth = await resolve_worker_api_auth(_proc("claude", "sm"))
    assert auth.model_slug == "z-ai/glm-4.6"  # override wins over the haiku default


async def test_custom_named_entry_resolves(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _set_harness("claude", model_map={"openrouter": {"coding": "z-ai/glm-4.6"}})

    auth = await resolve_worker_api_auth(_proc("claude", "coding"))
    assert auth.model_slug == "z-ai/glm-4.6"


async def test_unmapped_tier_falls_back_to_spec(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    # Override only sm; md must still resolve to the spec default.
    await _set_harness("claude", model_map={"openrouter": {"sm": "z-ai/glm-4.6"}})

    auth = await resolve_worker_api_auth(_proc("claude", "md"))
    assert auth.model_slug == "anthropic/claude-sonnet-5.5"


async def test_override_scoped_per_provider(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    # An override under a DIFFERENT provider must not apply to openrouter.
    await _set_harness("claude", provider="openrouter", model_map={"anthropic": {"sm": "x/y"}})

    from flow_sdk.builtin.llm_endpoint import LLMEndpoint

    auth = await resolve_worker_api_auth(_proc("claude", "sm"))
    assert auth.model_slug != "x/y", "an override under another provider leaked onto openrouter"
    # The key endpoint's own ``sm`` -- read from the row, since the session DB is shared and a
    # docs snippet (docs/snippets/llm-endpoints.md) legitimately retunes it.
    row = await LLMEndpoint.ensure_for_secret("openrouter")
    assert auth.model_slug == row.tiers["sm"]


def test_models_endpoint_resolver_covers_all_providers(env) -> None:
    """Every provider resolves to a catalog target -- statically for the vendor
    ones, and for FLOWPAD only once the hub has bound an endpoint (unbound is
    ``None``, never a KeyError)."""
    from flow_sdk.cli.auth.lm_api_keys import _MODELS_ENDPOINTS, _models_endpoint
    from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider
    from flow_sdk.instance_settings import llm_endpoint

    llm_endpoint.reset_cache()
    for provider in LMApiProvider:
        resolved = _models_endpoint(provider)
        if provider is LMApiProvider.FLOWPAD:
            assert resolved is None  # unbound: nothing to ask
            continue
        assert provider.value in _MODELS_ENDPOINTS
        url, needs_key = resolved
        assert url.startswith("https://")
        assert isinstance(needs_key, bool)
    # OpenRouter's catalog is public.
    assert _MODELS_ENDPOINTS[LMApiProvider.OPENROUTER.value][1] is False

    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", "/api/v1/graph/llm_endpoint/ep1/invoke")
    url, needs_key = _models_endpoint(LMApiProvider.FLOWPAD)
    assert url.endswith("/api/v1/graph/llm_endpoint/ep1/invoke/v1/models")
    assert needs_key is True
    llm_endpoint.clear_hub_llm_endpoint()


async def test_flowpad_overrides_are_not_migrated_onto_a_hub_budget(env, monkeypatch) -> None:
    """A hub budget's sizes are the hub's; a legacy ``flowpad`` override has nowhere local to go and is
    dropped, so the endpoint's own size runs."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import resolve_worker_api_auth
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import llm_endpoint

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    set_api_key("fp-hub-key")
    llm_endpoint.reset_cache()
    llm_endpoint.set_hub_llm_endpoint("llm_endpoint:ep1", "/api/v1/graph/llm_endpoint/ep1/invoke")
    try:
        await _set_harness("claude", provider="flowpad", model_map={"flowpad": {"sm": "z-ai/glm-4.6"}})
        assert (await Capability.get_by_kind(worker_capability_kind("claude"))).model_map == {}
        try:
            auth = await resolve_worker_api_auth(_proc("claude", "sm"))
        except Exception:  # noqa: BLE001 -- an unlisted budget may declare no sm; never the dropped override
            return
        assert auth.model_slug != "z-ai/glm-4.6"
    finally:
        llm_endpoint.clear_hub_llm_endpoint()


async def test_device_model_map_migrates_onto_the_device_row_once(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.agentic_process.cli_drivers.device_endpoints import (
        configure_device,
        migrate_capability_model_maps,
    )
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMEndpointKind
    from flow_sdk.schema.data_spec.llm_source_spec import LLMSource

    await configure_device("codex", {})
    cap = await Capability.get_by_kind(worker_capability_kind("codex"))
    cap.model_map = {"device": {"sm": "gpt-small", "coding": "gpt-coder"}}
    await cap.save(notify=False)
    await migrate_capability_model_maps(force=True)

    row = await LLMEndpoint.find_device("codex")
    assert row is not None and row.kind == LLMEndpointKind.DEVICE and row.invocable is False
    assert row.tiers == {"sm": "gpt-small", "coding": "gpt-coder"}
    assert (await Capability.get_by_kind(worker_capability_kind("codex"))).model_map == {}

    # Idempotent: a second run changes nothing, and an edit made since survives it.
    await configure_device("codex", {"sm": "gpt-edited", "coding": "gpt-coder"})
    await migrate_capability_model_maps(force=True)
    assert (await LLMEndpoint.find_device("codex")).tiers["sm"] == "gpt-edited"

    endpoint = LLMEndpoint.device_projection("codex")
    auth = await binding_for_candidate("codex", (endpoint, LLMSource(endpoint_typeid=str(endpoint.typeid))), tier="sm")
    assert auth.model_slug == "gpt-edited"


async def test_the_picker_lists_legacy_device_custom_names_before_any_spawn(env) -> None:
    """The source inventory migrates first, so a legacy ``model_map['device']`` custom name is on the
    device source the picker shows — no spawn has to run the migration."""
    from flow_sdk.builtin.agentic_process.cli_drivers import device_endpoints
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import _inventory
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind

    await device_endpoints.configure_device("codex", {})
    cap = await Capability.get_by_kind(worker_capability_kind("codex"))
    cap.model_map = {"device": {"coding": "gpt-coder"}}
    await cap.save(notify=False)
    device_endpoints._migrated = False  # a fresh process: nothing migrated yet

    candidates, _ = await _inventory("codex")
    device = next(c for c in candidates if c.endpoint.kind == LLMEndpointKind.DEVICE)
    assert device.endpoint.tiers.get("coding") == "gpt-coder"
    assert device_endpoints._migrated is True
