"""LLM API-provider identifiers.

A provider is an *account/endpoint* a key authenticates against — not a model
(GLM, e.g., is a model reached through OpenRouter, so it is not a provider here).

Sibling provider enums exist for other layers (``LLMProvider`` in
``external_apis/llm/llm_drivers``, ``APIProvider`` in ``simple_llm/completion``);
their values differ (TitleCase / a different provider set), so this store keeps
its own lowercase values that double as sod-key suffixes. Consolidate if a
fourth one appears.
"""

from __future__ import annotations

from flow_sdk._compat import StrEnum


class LMApiProvider(StrEnum):
    """An LLM API provider a stored key authenticates against."""

    OPENROUTER = "openrouter"
    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    # The FlowPad hub's ``LLMEndpoint``: the box calls the hub with the login key
    # it already holds and the hub swaps in the provider's key. There is no
    # ``lm_api.flowpad`` secret -- the "key" IS the hub login (see
    # ``cli/auth/lm_api_keys.get_lm_api``) and the binding is pushed by the hub
    # (see ``instance_settings/llm_endpoint.py``).
    FLOWPAD = "flowpad"
