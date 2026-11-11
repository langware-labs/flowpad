"""A prompt op is an API call: the box's LLM source for it must be a provider that has an API dialect.

A stored Vertex source ranked first and was picked, then the call failed with "unknown LLM provider 'vertex'".
A hub endpoint that names no provider still has a dialect (``openrouter``), so it stays a valid source.
"""

from types import SimpleNamespace

import pytest

from flow_sdk.builtin.llm_endpoint import LLMEndpoint
from flow_sdk.core.compute_op import runner


def _rank(monkeypatch, *endpoints):
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source

    async def candidates(_worker):
        return [SimpleNamespace(endpoint=endpoint) for endpoint in endpoints]

    monkeypatch.setattr(llm_source, "list_llm_candidates", candidates)
    monkeypatch.setattr(llm_source, "pick_llm_candidate", lambda cs: cs[0] if cs else None)


@pytest.mark.asyncio
async def test_a_source_without_an_api_dialect_is_not_the_box_llm(monkeypatch):
    _rank(monkeypatch, LLMEndpoint(provider="vertex"), LLMEndpoint(provider="openrouter"))
    chosen = await runner._box_llm()
    assert chosen is not None and chosen.provider == "openrouter"


@pytest.mark.asyncio
async def test_a_hub_endpoint_with_an_empty_provider_is_not_dropped(monkeypatch):
    hub_endpoint = LLMEndpoint(id="11111111-2222-4333-8444-555555555555", name="team budget")
    _rank(monkeypatch, hub_endpoint)
    assert await runner._box_llm() is hub_endpoint
