"""Model factories for the Deep Agents runner.

A factory is ``callable(model_slug) -> BaseChatModel``, named on the runner's command line as
``--model-factory module:callable``. Production uses :func:`openai_wire_model`; a test names its
own scripted model through the same argument, so the runner has no test-only branch.
"""

from __future__ import annotations

import os

from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import API_KEY_ENV, BASE_URL_ENV


def openai_wire_model(model: str):
    """The chat-completions wire against whatever funds this turn (OpenRouter, a hub endpoint).

    An INSTANCE, never an ``openai:<slug>`` string: deepagents' provider profile forces the
    Responses API for the string form, which a gateway does not speak.
    """
    from langchain_openai import ChatOpenAI

    base_url = os.environ.get(BASE_URL_ENV, "").strip()
    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not base_url or not api_key:
        raise RuntimeError(
            f"the deepagents worker is funded by an LLM endpoint: {BASE_URL_ENV} and {API_KEY_ENV} must both be set"
        )
    return ChatOpenAI(model=model, base_url=base_url, api_key=api_key, use_responses_api=False, stream_usage=True)
