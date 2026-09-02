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


def _endpoint_or_skip(provider: str) -> LLMEndpoint:
    dialect = get_dialect(provider)
    if not os.environ.get(dialect.env_var):
        pytest.skip(f"{dialect.env_var} is not set")
    endpoint = LLMEndpoint(provider=provider)
    assert endpoint.kind == LLMEndpointKind.API_KEY
    return endpoint


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", COMPLETION_PROVIDERS)
async def test_a_local_endpoint_completes(provider):
    """The small tier answers a question with a checkable answer."""
    endpoint = _endpoint_or_skip(provider)
    reply = await endpoint.create_completion(
        "You answer with a single digit and nothing else.",
        "What is four minus one?",
        model=endpoint.models["sm"],
    )
    assert isinstance(reply, str)
    assert "3" in reply


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", EMBEDDING_PROVIDERS)
async def test_a_local_endpoint_embeds(provider):
    """Vectors come back one per input, in order, all the same width."""
    endpoint = _endpoint_or_skip(provider)
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
    endpoint = _endpoint_or_skip(provider)
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
    assert endpoint.models["embedding"] in slugs
