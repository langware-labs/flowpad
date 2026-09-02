"""``LLMEndpoint`` as the one funding shape: three kinds, one row type, one client.

What these pin: which of the three kinds a construction means, that only a local key
endpoint is ever stored, where its credential comes from, and that the ergonomic
``LLMEndpoint(provider=...)`` form works with no database and no stored secret — the form
``docs/snippets/llm-endpoints.md`` promises.

Isolation matches tests/unit/test_hub_llm_endpoint.py: a temp FLOW_HOME + fresh instance
singleton + SOD_ENC_KEY so the credential store resolves headlessly.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
from cryptography.fernet import Fernet

from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMEndpointKind
from flow_sdk.external_apis.llm.errors import LLMNotInvocable

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "llmendpointrows")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())

    from flow_sdk.config import default_service_config
    from flow_sdk.instance_settings import llm_endpoint, reset_instance_settings

    monkeypatch.setattr(default_service_config, "flowpad_hub_url", "https://hub.test")
    for attr in ("openrouter_api_key", "openai_api_key", "anthropic_api_key"):
        monkeypatch.setattr(default_service_config, attr, None, raising=False)
    for var in ("OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(var, raising=False)

    reset_instance_settings()
    llm_endpoint.reset_cache()
    yield
    llm_endpoint.clear_hub_llm_endpoint()
    llm_endpoint.reset_cache()
    reset_instance_settings()


# ── which kind a construction means ──────────────────────────────────────────


def test_a_named_provider_with_no_hub_id_is_a_local_key_endpoint(env):
    """The ergonomic form: name a provider, get something callable."""
    endpoint = LLMEndpoint(provider="openrouter")
    assert endpoint.kind == LLMEndpointKind.API_KEY
    assert endpoint.base_url == "https://openrouter.ai/api"
    assert endpoint.secret_name == "lm_api.openrouter"
    assert endpoint.models["embedding"] == "openai/text-embedding-3-small"
    assert endpoint.name == "openrouter key"


def test_a_hub_projection_keeps_every_field_the_hub_sent(env):
    """Defaults must never be painted over a value that arrived from somewhere else."""
    endpoint = LLMEndpoint(id="11111111-2222-4333-8444-555555555555", name="team budget")
    assert endpoint.kind == LLMEndpointKind.HUB
    assert (endpoint.base_url, endpoint.secret_name, endpoint.models) == ("", "", {})


def test_an_explicit_kind_always_wins(env):
    assert LLMEndpoint(provider="openai", kind=LLMEndpointKind.HUB).kind == LLMEndpointKind.HUB


def test_an_unknown_provider_is_left_alone_rather_than_guessed(env):
    endpoint = LLMEndpoint(provider="not-a-provider")
    assert endpoint.kind == LLMEndpointKind.API_KEY
    assert (endpoint.base_url, endpoint.models) == ("", {})


@pytest.mark.asyncio
async def test_the_hub_listing_forces_the_hub_kind_whatever_the_hub_sent(env, monkeypatch):
    """``kind`` is ours. A hub field of the same name must not reclassify a budget."""
    from flow_sdk.instance_settings import llm_endpoint as settings

    row = {"id": "11111111-2222-4333-8444-555555555555", "name": "b", "provider": "openai", "kind": "api_key"}

    async def _fake_get(_type, action=None, **_kw):
        return {"data": [row]} if action is None else []

    monkeypatch.setattr("flow_sdk.cloud_client.transport.hub_http.hub_get", _fake_get)
    settings.reset_cache()
    endpoints = await settings.fetch_hub_llm_endpoints()
    assert [e.kind for e in endpoints] == [LLMEndpointKind.HUB]


# ── credentials ──────────────────────────────────────────────────────────────


def test_an_explicit_key_beats_everything_and_is_never_a_field(env, monkeypatch):
    monkeypatch.setenv("OPENROUTER_API_KEY", "from-env")
    endpoint = LLMEndpoint(provider="openrouter", api_key="explicit")
    assert endpoint.resolve_api_key() == "explicit"
    # A PrivateAttr: it cannot be dumped, wired, persisted or shared.
    assert "api_key" not in endpoint.model_dump(mode="json")
    assert "explicit" not in str(endpoint.to_wire())


def test_a_stored_secret_beats_the_environment(env, monkeypatch):
    from flow_sdk.cli.auth.secrets import write_secret

    monkeypatch.setenv("OPENROUTER_API_KEY", "from-env")
    write_secret("lm_api.openrouter", "from-sod")
    assert LLMEndpoint(provider="openrouter").resolve_api_key() == "from-sod"


def test_the_environment_funds_an_endpoint_with_nothing_stored(env, monkeypatch):
    """This is what makes the constructor form usable in a script."""
    monkeypatch.setenv("OPENROUTER_API_KEY", "from-env")
    assert LLMEndpoint(provider="openrouter").resolve_api_key() == "from-env"


def test_process_config_is_the_last_resort(env, monkeypatch):
    from flow_sdk.config import default_service_config

    monkeypatch.setattr(default_service_config, "openai_api_key", "from-config", raising=False)
    assert LLMEndpoint(provider="openai").resolve_api_key() == "from-config"


def test_no_credential_anywhere_is_none_not_an_error(env):
    assert LLMEndpoint(provider="openrouter").resolve_api_key() is None


def test_a_hub_endpoint_spends_the_hub_login_key(env):
    from flow_sdk.cli.auth.hub_login import set_api_key

    set_api_key("fp-hub-key")
    endpoint = LLMEndpoint(id="11111111-2222-4333-8444-555555555555", name="team budget", provider="openrouter")
    assert endpoint.kind == LLMEndpointKind.HUB
    assert endpoint.resolve_api_key() == "fp-hub-key"


# ── the client ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_an_endpoint_embeds_with_no_database_and_no_stored_key(env, monkeypatch):
    """Snippet #1: construct from the environment and embed. Nothing saved, nothing seeded."""
    calls: dict = {}

    class _Fake:
        def __init__(self, **kwargs):
            calls.update(kwargs)
            self.embeddings = SimpleNamespace(create=self._create)

        async def _create(self, *, model, input):
            calls["model"] = model
            return SimpleNamespace(data=[SimpleNamespace(embedding=[0.5, 0.5]) for _ in input])

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", _Fake)
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")

    vectors = await LLMEndpoint(provider="openrouter").create_embeddings(["hello", "world"])
    assert vectors == [[0.5, 0.5], [0.5, 0.5]]
    assert calls["base_url"] == "https://openrouter.ai/api/v1"
    assert calls["api_key"] == "sk-or-test"
    assert calls["model"] == "openai/text-embedding-3-small"


@pytest.mark.asyncio
async def test_a_hub_endpoint_calls_the_hub_not_the_vendor(env, monkeypatch):
    """The hub relays verbatim, so the wire is the root's — only the URL and the token move."""
    calls: dict = {}

    class _Fake:
        def __init__(self, **kwargs):
            calls.update(kwargs)
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        async def _create(self, **params):
            calls["params"] = params
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content="hi"))])

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", _Fake)
    from flow_sdk.cli.auth.hub_login import set_api_key

    set_api_key("fp-hub-key")

    endpoint = LLMEndpoint(
        id="11111111-2222-4333-8444-555555555555",
        name="team budget",
        provider="openrouter",
        models={"md": "anthropic/claude-sonnet-4.5"},
    )
    assert await endpoint.create_completion("sys", "user") == "hi"
    assert calls["base_url"] == "https://hub.test/api/v1/graph/llm_endpoint/11111111-2222-4333-8444-555555555555/invoke/v1"
    assert calls["api_key"] == "fp-hub-key"


@pytest.mark.asyncio
async def test_a_device_login_is_never_callable_in_process(env):
    """OAuth credentials for a terminal are not API credentials, and saying so beats a 401."""
    device = LLMEndpoint.device_projection("claude")
    assert (device.kind, device.invocable, device.harness) == (LLMEndpointKind.DEVICE, False, "claude")
    with pytest.raises(LLMNotInvocable):
        device.client()
    assert await device.list_models() == []
    assert (await device.probe()).ok is False


def test_a_device_projection_keeps_the_same_id_across_reads(env):
    """A picker's selection would flap if a re-list minted a new id."""
    assert LLMEndpoint.device_projection("claude").id == LLMEndpoint.device_projection("claude").id
    assert LLMEndpoint.device_projection("claude").id != LLMEndpoint.device_projection("codex").id


# ── local rows ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_only_a_local_key_endpoint_is_stored(env):
    hub = LLMEndpoint(id="11111111-2222-4333-8444-555555555555", name="team budget")
    with pytest.raises(ValueError, match="only api_key endpoints"):
        await hub.save()
    with pytest.raises(ValueError, match="only api_key endpoints"):
        await LLMEndpoint.device_projection("claude").save()


@pytest.mark.asyncio
async def test_a_local_endpoint_cannot_be_shared(env):
    """Sharing hands somebody a hub budget; a key on this machine is not one."""
    with pytest.raises(ValueError, match="cannot be shared"):
        await LLMEndpoint(provider="openrouter").share(["bob@example.com"])


@pytest.mark.asyncio
async def test_ensure_for_secret_converges_on_one_row(env):
    """Idempotency by LOOKUP on the natural key, never by deriving an id from it."""
    first = await LLMEndpoint.ensure_for_secret("openrouter")
    second = await LLMEndpoint.ensure_for_secret("openrouter")
    assert first.id == second.id
    assert await LLMEndpoint.find_by_secret("lm_api.openrouter") is not None
    rows = await LLMEndpoint.get_all({"kind": LLMEndpointKind.API_KEY.value})
    assert len([r for r in rows if r.secret_name == "lm_api.openrouter"]) == 1


@pytest.mark.asyncio
async def test_a_row_survives_a_round_trip_with_its_models(env):
    saved = await LLMEndpoint.ensure_for_secret("openai")
    loaded = await LLMEndpoint.find_by_secret("lm_api.openai")
    assert loaded is not None
    assert loaded.provider == "openai"
    assert loaded.models["embedding"] == "text-embedding-3-small"
    assert loaded.base_url == "https://api.openai.com"
    assert loaded.id == saved.id


@pytest.mark.asyncio
async def test_find_by_secret_is_empty_rather_than_guessing(env):
    assert await LLMEndpoint.find_by_secret("") is None
    assert await LLMEndpoint.find_by_secret("lm_api.nothing-here") is None
