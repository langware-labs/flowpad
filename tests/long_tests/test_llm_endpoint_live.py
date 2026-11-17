"""Live proof that an ``LLMEndpoint`` really completes and really embeds.

Every unit test around this uses a fake OpenAI client, which proves the wiring and nothing
about the provider. These call out for real, one per provider, and skip when that
provider's key is absent — so they cost nothing on a machine without keys and catch the
things a fake cannot: a model slug that no longer exists, a wire quirk, an auth header the
provider stopped accepting.

Run one with, e.g.::

    OPENROUTER_API_KEY=sk-or-… uv run pytest tests/long_tests/test_llm_endpoint_live.py -k openrouter

The key is read straight from the environment, which is the same path
``LLMEndpoint(provider=...)`` uses when nothing is stored — so a pass here also proves the
snippet form in ``docs/snippets/llm-endpoints.md``.

The ``hub`` row is the endpoint a new Flowpad user's box spends instead of a key: a sign-in
to the LOCAL hub (``FLOWPAD_HUB_URL``) as a brand-new user, whose default allowance draws on
the hub's own root (Vertex on the QA hub). It needs no provider key at all. The probe and
model-catalog tests stay per-provider: their subject is a provider's own key and catalog.
"""

from __future__ import annotations

import os

import pytest

from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMEndpointKind
from flow_sdk.external_apis.llm.dialects import get_dialect

pytestmark = pytest.mark.timeout(120)  # do not increase timeout without approval

#: Providers that can answer a chat turn. Anthropic is here; it has no embeddings API.
COMPLETION_PROVIDERS = ["openrouter", "openai", "anthropic"]
#: Providers with an embeddings endpoint.
EMBEDDING_PROVIDERS = ["openrouter", "openai"]
# No [hub] row for embeddings: a hub allowance carries only sm/md/lg tiers (the hub's TIER_NAMES), so there is
# no embedding model to call through it (QA cycle qa-20261112-225208: product gap, reported, not tested here).
#: The row funded by a hub allowance rather than a provider key.
HUB = "hub"


def _endpoint_or_skip(provider: str) -> LLMEndpoint:
    dialect = get_dialect(provider)
    if not os.environ.get(dialect.env_var):
        pytest.skip(
            f"{dialect.env_var} is not set -- this row's subject is a direct {provider} key; "
            "the QA program funds LLM tests only through a (Vertex) hub endpoint"
        )
    endpoint = LLMEndpoint(provider=provider)
    assert endpoint.kind == LLMEndpointKind.API_KEY
    return endpoint


async def _any_endpoint_or_skip(provider: str) -> LLMEndpoint:
    """``provider``'s local key endpoint, or for ``hub`` a new user's hub allowance."""
    if provider != HUB:
        return _endpoint_or_skip(provider)
    from flow_sdk.cloud_client.hub_proxy import HubProxy
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints
    from tests.long_tests.conftest import _sign_in_to_the_local_hub

    await _sign_in_to_the_local_hub("llm endpoint live")
    await HubProxy.try_call("GET", "bootstrap")  # mints the default allowance on first contact
    endpoints = await fetch_hub_llm_endpoints()
    if not endpoints:
        pytest.skip("the local hub offered this box no LLM endpoint to spend")
    endpoint = endpoints[0]
    assert endpoint.kind == LLMEndpointKind.HUB
    return endpoint


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", [*COMPLETION_PROVIDERS, HUB])
async def test_a_local_endpoint_completes(provider):
    """The small tier answers a question with a checkable answer."""
    endpoint = await _any_endpoint_or_skip(provider)
    reply = await endpoint.create_completion(
        "You answer with a single digit and nothing else.",
        "What is four minus one?",
        model=endpoint.tiers["sm"],
    )
    assert isinstance(reply, str)
    assert "3" in reply


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", EMBEDDING_PROVIDERS)
async def test_a_local_endpoint_embeds(provider):
    """Vectors come back one per input, in order, all the same width."""
    endpoint = await _any_endpoint_or_skip(provider)
    vectors = await endpoint.create_embeddings(["a hot day in July", "a cold night in January"])
    assert len(vectors) == 2
    assert len({len(v) for v in vectors}) == 1
    assert len(vectors[0]) > 100
    # Different texts must not produce the same vector — the cheapest proof the model ran
    # rather than something answering a constant.
    assert vectors[0] != vectors[1]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", EMBEDDING_PROVIDERS)
async def test_embeddings_place_like_with_like(provider):
    """A real embedding puts the two summer sentences nearer each other than the winter one."""
    endpoint = await _any_endpoint_or_skip(provider)
    summer_a, summer_b, winter = await endpoint.create_embeddings(
        ["the beach was hot and sunny", "we swam in the warm sea all afternoon", "the blizzard closed the mountain road"]
    )

    def _cosine(u, v):
        dot = sum(a * b for a, b in zip(u, v))
        norm = (sum(a * a for a in u) ** 0.5) * (sum(b * b for b in v) ** 0.5)
        return dot / norm if norm else 0.0

    assert _cosine(summer_a, summer_b) > _cosine(summer_a, winter)


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", COMPLETION_PROVIDERS)
async def test_a_live_probe_accepts_a_real_key_and_rejects_a_fake_one(provider):
    endpoint = _endpoint_or_skip(provider)
    assert (await endpoint.probe()).ok is True

    bogus = LLMEndpoint(provider=provider, api_key="sk-definitely-not-a-real-key")
    assert (await bogus.probe()).ok is False


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", EMBEDDING_PROVIDERS)
async def test_the_default_embedding_model_still_exists(provider):
    """A default slug that the provider has retired is a silent break until something calls it."""
    endpoint = _endpoint_or_skip(provider)
    slugs = await endpoint.list_models(embeddings_only=True)
    if not slugs:
        pytest.skip(f"{provider} did not answer a model catalog")
    assert endpoint.tiers["embedding"] in slugs
