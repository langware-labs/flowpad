"""A prompt op is an API call: the box's LLM source for it must be a provider that has an API dialect.

A stored Vertex source ranked first and was picked, then the call failed with "unknown LLM provider 'vertex'".
"""
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.llm_endpoint import LLMEndpointKind
from flow_sdk.core.compute_op import runner


def _candidate(provider: str):
    return SimpleNamespace(endpoint=SimpleNamespace(provider=provider, kind=LLMEndpointKind.API_KEY
                                                    if hasattr(LLMEndpointKind, "API_KEY") else list(LLMEndpointKind)[0]))


@pytest.mark.asyncio
async def test_a_source_without_an_api_dialect_is_not_the_box_llm(monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source

    async def candidates(_worker):
        return [_candidate("vertex"), _candidate("openrouter")]

    monkeypatch.setattr(llm_source, "list_llm_candidates", candidates)
    monkeypatch.setattr(llm_source, "pick_llm_candidate", lambda cs: cs[0] if cs else None)
    chosen = await runner._box_llm()
    assert chosen is not None and chosen.provider == "openrouter"
