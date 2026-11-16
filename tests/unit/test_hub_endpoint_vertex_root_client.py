"""A hub endpoint whose ROOT is a provider the box has no dialect for (Vertex) is still callable.

The hub serves OpenAI ``v1/chat/completions`` and ``v1/embeddings`` for every root it relays to
(``flowpad-hub``: ``core/llm/vertex.py`` maps them to Vertex's ``endpoints/openapi``). The box used
to look the root's provider up in its own dialect table, so a Vertex-funded hub allowance -- the
default a new user gets on a Vertex-rooted hub -- raised ``unknown LLM provider 'vertex'`` on the
first completion (QA i24, p12 ``test_call_returns_live``).
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMEndpointKind
from flow_sdk.flowpad_types.enums import LMApiProvider

pytestmark = [pytest.mark.timeout(10)]  # do not increase timeout without approval


def _hub_endpoint(provider: str) -> LLMEndpoint:
    return LLMEndpoint(id="0b9a8c2e-5f4d-4c3b-9a1e-7d6f5e4c3b2a", name="me default", provider=provider, kind=LLMEndpointKind.HUB,
                       tiers={"sm": "zai-org/glm-5-maas"})


def test_a_vertex_rooted_hub_endpoint_speaks_the_openai_wire_to_the_hub(monkeypatch):
    from flow_sdk.instance_settings import llm_endpoint as hub_settings

    monkeypatch.setattr(hub_settings, "hub_origin", lambda: "http://hub.test")
    endpoint = _hub_endpoint("vertex")
    client = endpoint.client()
    assert client.dialect.provider is LMApiProvider.OPENAI
    assert client.base_url == f"http://hub.test{endpoint.invoke_path()}"
    assert client.models == {"sm": "zai-org/glm-5-maas"}
    assert endpoint.dialect is not None and endpoint.dialect.provider is LMApiProvider.OPENAI


def test_a_hub_endpoint_on_a_known_root_keeps_that_roots_wire(monkeypatch):
    from flow_sdk.instance_settings import llm_endpoint as hub_settings

    monkeypatch.setattr(hub_settings, "hub_origin", lambda: "http://hub.test")
    assert _hub_endpoint("anthropic").client().dialect.provider is LMApiProvider.ANTHROPIC
    assert _hub_endpoint("").client().dialect.provider is LMApiProvider.OPENROUTER


def test_a_local_key_endpoint_on_an_unknown_provider_is_still_refused():
    with pytest.raises(ValueError, match="unknown LLM provider"):
        LLMEndpoint(id="1c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", provider="vertex", kind=LLMEndpointKind.API_KEY).client()
