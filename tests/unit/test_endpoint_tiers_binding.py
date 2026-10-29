"""An LLM endpoint declares the model each size runs; a funded spawn runs exactly that.

``binding_for_candidate`` -> ``api_auth._slug_for``: a size (``sm``/``md``/``lg``, a harness's own word
for one, or nothing -> ``preferences.llm.default_size``) reads ``Capability.model_map`` then
``endpoint.tiers``; a size the endpoint does not declare is refused in words; anything else is a
named model and runs as named. Isolation copies tests/unit/test_api_auth_binding.py.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from tests.utils.harness_installed import harness_installed  # noqa: F401 — a fixture

pytestmark = pytest.mark.usefixtures("harness_installed")

TIERS = {"sm": "vendor/small-1", "md": "vendor/medium-2", "lg": "vendor/large-3"}


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    for name in ("FLOW_HOME", "FLOW_INSTANCE", "SOD_ENC_KEY", "FLOWPAD_SKIP_DOTENV"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "endpointtiers")
    monkeypatch.setenv("SOD_ENC_KEY", Fernet.generate_key().decode())
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    yield
    reset_instance_settings()


@pytest.fixture(autouse=True)
async def _reset_model_maps():
    """``Capability.model_map`` persists into the shared session DB; leave none behind."""
    yield
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability

    for worker in ("claude", "opencode"):
        cap = await Capability.get_by_kind(worker_capability_kind(worker))
        if cap is not None and getattr(cap, "model_map", None):
            cap.model_map = {}
            await cap.save(notify=False)


def _candidate(models: dict):
    """A hub endpoint declaring *models*, already chosen to fund the spawn."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import Candidate
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    from flow_sdk.cli.auth.hub_login import set_api_key
    from flow_sdk.schema.data_spec.llm_source_spec import LLMSource, LLMSourceAuthority

    set_api_key("fp-hub-key")
    endpoint = LLMEndpoint.projection("hub", "tiers-ep", name="Tiers", provider="openrouter", tiers=dict(models))
    source = LLMSource(
        endpoint_typeid=str(endpoint.typeid),
        name=endpoint.name,
        rank=0,
        eligible=True,
        auto=True,
        authority=LLMSourceAuthority.CACHED,
    )
    return Candidate(endpoint, source)


async def _bind(worker: str, tier: str | None, models: dict = TIERS):
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import binding_for_candidate

    return await binding_for_candidate(worker, _candidate(models), tier=tier)


def _claude_env(auth) -> dict:
    """The env a claude spawn with no argv (the prompt surface) gets: the slug rides ``ANTHROPIC_MODEL``."""
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import CLAUDE_API_AUTH_SPEC, _prompt_env

    return _prompt_env(CLAUDE_API_AUTH_SPEC, auth)


async def test_no_tier_runs_the_endpoints_md_slug(env) -> None:
    auth = await _bind("claude", None)
    assert _claude_env(auth)["ANTHROPIC_MODEL"] == TIERS["md"]
    assert auth.model_slug == TIERS["md"]


async def test_the_default_size_preference_picks_the_slug(env) -> None:
    from flow_sdk.preferences import PREF_LLM_DEFAULT_SIZE, write_instance_pref

    assert write_instance_pref(PREF_LLM_DEFAULT_SIZE, "sm")
    auth = await _bind("claude", None)
    assert _claude_env(auth)["ANTHROPIC_MODEL"] == TIERS["sm"]


async def test_a_size_reads_that_size(env) -> None:
    auth = await _bind("claude", "lg")
    assert auth.model_slug == TIERS["lg"]


async def test_claudes_own_size_word_is_a_size(env) -> None:
    auth = await _bind("claude", "haiku")
    assert auth.model_slug == TIERS["sm"]


async def test_a_size_the_endpoint_does_not_declare_is_refused_in_words(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import WorkerSpawnError

    with pytest.raises(WorkerSpawnError, match="declares no 'lg' model"):
        await _bind("claude", "lg", models={"sm": TIERS["sm"], "md": TIERS["md"]})


async def test_a_named_model_passes_through(env) -> None:
    auth = await _bind("claude", "someone/their-model-9")
    assert auth.model_slug == "someone/their-model-9"


async def test_opencode_spells_the_slug_with_its_provider_prefix(env) -> None:
    auth = await _bind("opencode", "md")
    assert auth.model_slug == f"openrouter/{TIERS['md']}"
    # Already prefixed: not doubled.
    auth = await _bind("opencode", "md", models={"md": "openrouter/vendor/medium-2"})
    assert auth.model_slug == "openrouter/vendor/medium-2"


async def test_a_capability_model_map_override_wins_over_the_endpoint(env) -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.lm_api import LMApiProvider

    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    # A hub endpoint is spent through the FLOWPAD binding, so that is the provider the map is keyed by.
    cap.model_map = {LMApiProvider.FLOWPAD.value: {"md": "override/medium"}}
    await cap.save(notify=False)

    assert (await _bind("claude", "md")).model_slug == "override/medium"
    assert (await _bind("claude", "sm")).model_slug == TIERS["sm"], "only the overridden size changes"


def test_row_tiers_prefer_the_chain_expansion() -> None:
    from flow_sdk.instance_settings.llm_endpoint import _tier_models

    row = {"tiers": {"sm": "own/sm"}, "expand": {"tiers": {"sm": "chain/sm", "md": "chain/md", "lg": None}}}
    assert _tier_models(row) == {"sm": "chain/sm", "md": "chain/md"}


def test_row_tiers_fall_back_to_the_rows_own_and_drop_empty() -> None:
    from flow_sdk.instance_settings.llm_endpoint import _tier_models

    assert _tier_models({"tiers": {"sm": "own/sm", "md": None, "lg": ""}}) == {"sm": "own/sm"}
    assert _tier_models({"expand": {}, "tiers": {"lg": "own/lg"}}) == {"lg": "own/lg"}
    assert _tier_models({}) == {}
