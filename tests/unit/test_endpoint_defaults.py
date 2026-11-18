"""Endpoint-owned model selection; no provider calls or worker processes."""

import pytest

from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMEndpointConfig
from flow_sdk.external_apis.llm.errors import LLMError
from flow_sdk.external_apis.llm.model_selection import EndpointModelConfig, resolve_completion_model
from flow_sdk.instance_settings.llm_endpoint import fetch_model_config
from tests.utils.hub_proxy_fake import FakeHub, model_config_transport

ENDPOINT = "llm_endpoint-11111111-2222-4333-8444-555555555555"


@pytest.mark.parametrize(("model", "default", "expected"), [
    (None, None, "small"), (None, "lg", "large"), (None, "custom/model", "custom/model"),
    ("md", "lg", "medium"), ("explicit/model", "embedding", "explicit/model"),
])
def test_endpoint_model_precedence(model, default, expected):
    tiers = {"sm": "small", "md": "medium", "lg": "large", "embedding": "vector"}
    assert resolve_completion_model(tiers, model, default_model=default) == expected


@pytest.mark.parametrize("default", [None, "md", "embedding"])
def test_invalid_default_never_chooses_another_tier(default):
    with pytest.raises(LLMError):
        resolve_completion_model({"lg": "large"}, default_model=default)


def test_hub_unavailable_default_is_not_local_sm_fallback():
    config = EndpointModelConfig(endpoint_typeid="llm_endpoint-example", tiers={"sm": "small"},
                                 default_model=None, effective_default_model=None)
    with pytest.raises(LLMError):
        config.resolve()
    assert config.resolve("explicit/model") == "explicit/model"
    assert config.resolve("sm") == "small"


@pytest.mark.parametrize("provider", ["openai", "anthropic", "vertex"])
async def test_clients_and_local_projection_share_default(provider):
    endpoint = LLMEndpoint(provider=provider, tiers={"sm": "small", "lg": "large"}, default_model="lg")
    assert await endpoint.client()._completion_model(None) == "large"
    assert await endpoint.client()._completion_model("sm") == "small"
    assert endpoint.to_wire()["effective_default_model"] == "large"
    assert endpoint.client()._model_for(None, "sm") == "small"  # probe ignores completion default


def test_default_clear_and_omission_remain_distinct():
    assert "default_model" not in LLMEndpointConfig().model_fields_set
    clear = LLMEndpointConfig(default_model="  ")
    assert clear.default_model is None and "default_model" in clear.model_fields_set
    assert LLMEndpoint(default_model=" md ").default_model == "md"


async def test_explicit_empty_tiers_never_hydrate_provider_defaults():
    endpoint = LLMEndpoint(provider="openai", tiers={})
    assert endpoint.tiers == {}
    assert endpoint.to_wire()["effective_default_model"] is None
    with pytest.raises(LLMError):
        await endpoint.client()._completion_model(None)
    assert LLMEndpoint(provider="openai").tiers.get("sm")


async def test_saved_default_clear_survives_reload():
    endpoint = LLMEndpoint(provider="openai", secret_name="test.endpoint-default-clear",
                           tiers={"sm": "small", "lg": "large"}, default_model="lg")
    await endpoint.save(notify=False)
    loaded = await LLMEndpoint.get_by_id(endpoint.id)
    assert loaded.default_model == "lg"
    assert await loaded.client()._completion_model(None) == "large"
    loaded.default_model = None
    await loaded.save(notify=False)
    cleared = await LLMEndpoint.get_by_id(endpoint.id)
    assert cleared.default_model is None
    assert await cleared.client()._completion_model(None) == "small"


def test_native_anthropic_binding_owns_credentials_url_and_models():
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _claude_anthropic_binding

    endpoint = LLMEndpoint(provider="anthropic", base_url="https://anthropic.example/v1")
    auth = _claude_anthropic_binding(endpoint, "test-key", "claude-example")
    assert auth.env["ANTHROPIC_API_KEY"] == "test-key"
    assert auth.env["ANTHROPIC_BASE_URL"] == "https://anthropic.example"
    assert all(auth.env[k] == "" for k in ("ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
                                          "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_BEDROCK",
                                          "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_API_KEY"))
    assert auth.model_slug == auth.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] == "claude-example"
    assert auth.env["ANTHROPIC_SMALL_FAST_MODEL"] == auth.env["CLAUDE_CODE_SUBAGENT_MODEL"] == auth.model_slug


def test_native_openai_binding_is_an_explicit_key_backed_provider():
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import _codex_openai_binding

    auth = _codex_openai_binding(LLMEndpoint(provider="openai", base_url="https://openai.example/v1"),
                                "test-key", "gpt-example")
    config = dict(auth.config_overrides)
    prefix = f"model_providers.{auth.provider_key}."
    assert config["model_provider"] == auth.provider_key
    assert config[prefix + "base_url"] == "https://openai.example/v1"
    assert config[prefix + "wire_api"] == "responses"
    assert config[prefix + "env_key"] == auth.token_env_var == "OPENAI_API_KEY"
    assert auth.env["OPENAI_API_KEY"] == "test-key" and auth.env["OPENAI_BASE_URL"] == ""


@pytest.mark.parametrize("status", [0, 401, 403, 404, 405, 500, 501])
async def test_metadata_failure_is_not_an_unset_default(monkeypatch, status):
    FakeHub().on("GET", "llm_endpoint", action="model-config", fail=status).install_model_config_transport(monkeypatch)
    with pytest.raises(LLMError):
        await fetch_model_config(ENDPOINT, public=True)
    if status in (404, 405, 501):
        config = await fetch_model_config(ENDPOINT, public=True, model="vendor/exact")
        assert config.resolve("vendor/exact") == "vendor/exact"
    else:
        with pytest.raises(LLMError):
            await fetch_model_config(ENDPOINT, public=True, model="vendor/exact")
    with pytest.raises(LLMError):
        await fetch_model_config(ENDPOINT, public=True, model="sm")


@pytest.mark.parametrize("payload", [{}, {"endpoint_typeid": "llm_endpoint-22222222-2222-4333-8444-555555555555",
    "tiers": {}, "default_model": None, "effective_default_model": None}])
async def test_successful_malformed_metadata_never_uses_old_hub_compatibility(monkeypatch, payload):
    FakeHub().on("GET", "llm_endpoint", action="model-config", answer=payload).install_model_config_transport(monkeypatch)
    with pytest.raises(LLMError):
        await fetch_model_config(ENDPOINT, public=True, model="vendor/exact")


async def test_fresh_metadata_and_unavailable_default_keep_explicit_model_usable(monkeypatch):
    hub = model_config_transport(monkeypatch, {"sm": "small"})
    first = await fetch_model_config(ENDPOINT, public=True, model="vendor/exact")
    assert first.resolve("vendor/exact") == "vendor/exact"
    with pytest.raises(LLMError):
        first.resolve()
    hub.on("GET", "llm_endpoint", action="model-config", answer={"endpoint_typeid": ENDPOINT,
        "tiers": {"sm": "small", "lg": "large"}, "default_model": "lg", "effective_default_model": "large"})
    assert (await fetch_model_config(ENDPOINT, public=True)).resolve() == "large"
    assert len(hub.calls) == 2
