"""``llm_completion`` routing and the shared OpenAI-compatible client.

OpenRouter and Groq both speak the OpenAI wire protocol, so one client serves
both; these tests pin the routing (which base URL and key each provider gets)
and the three answer shapes — plain text, parsed JSON, and a stream — without
touching the network.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.external_apis.llm.simple_llm import (
    APIProvider,
    llm_completion,
    parse_model_string,
)
from flow_sdk.external_apis.llm.simple_llm import completion as completion_module


class _FakeCompletions:
    def __init__(self, recorder, reply):
        self._recorder = recorder
        self._reply = reply

    async def create(self, **params):
        self._recorder["params"] = params
        return self._reply


class _FakeClient:
    def __init__(self, recorder, reply):
        self.chat = SimpleNamespace(completions=_FakeCompletions(recorder, reply))


def _install_fake(monkeypatch, reply):
    recorder: dict = {}

    def _factory(*, base_url, api_key):
        recorder["base_url"] = base_url
        recorder["api_key"] = api_key
        return _FakeClient(recorder, reply)

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", _factory)
    _install_keys(monkeypatch)
    return recorder


def _install_keys(monkeypatch):
    """Give both providers a key.

    The client refuses to call an endpoint it has no credential for, rather than sending
    ``api_key=None`` and reading the provider's 401 back as an empty answer. These tests pin
    routing, so they need a key present for the call to get as far as the fake client.
    """
    from flow_sdk.config import default_service_config

    monkeypatch.setattr(default_service_config, "openrouter_api_key", "sk-or-test", raising=False)
    monkeypatch.setattr(default_service_config, "groq_api_key", "gsk-test", raising=False)


def _text_reply(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model", "expected_provider", "expected_model", "expected_base"),
    [
        ("anthropic/claude-sonnet-4.5", APIProvider.OPENROUTER, "anthropic/claude-sonnet-4.5",
         "https://openrouter.ai/api/v1"),
        ("openrouter/anthropic/claude-sonnet-4.5", APIProvider.OPENROUTER, "anthropic/claude-sonnet-4.5",
         "https://openrouter.ai/api/v1"),
        ("groq/meta-llama/llama-3.1-8b-instant", APIProvider.GROQ, "meta-llama/llama-3.1-8b-instant",
         "https://api.groq.com/openai/v1"),
    ],
)
async def test_routes_provider_to_its_endpoint(
    monkeypatch, model, expected_provider, expected_model, expected_base
):
    assert parse_model_string(model) == (expected_provider, expected_model)
    recorder = _install_fake(monkeypatch, _text_reply("hi"))
    assert await llm_completion("sys", "user", model=model) == "hi"
    assert recorder["base_url"] == expected_base
    assert recorder["params"]["model"] == expected_model
    assert recorder["params"]["messages"][0]["content"] == "sys"
    assert recorder["params"]["messages"][1]["content"] == "user"
    assert recorder["params"]["stream"] is False
    assert "extra_body" not in recorder["params"]


@pytest.mark.asyncio
async def test_reasoning_sets_extra_body(monkeypatch):
    recorder = _install_fake(monkeypatch, _text_reply("hi"))
    await llm_completion("sys", "user", reasoning=True)
    assert recorder["params"]["extra_body"] == {"reasoning": {"effort": "high"}}


@pytest.mark.asyncio
async def test_json_reply_parses_a_fenced_object(monkeypatch):
    _install_fake(monkeypatch, _text_reply('```json\n{"a": 1}\n```'))
    assert await llm_completion("sys", "user", json_reply=True) == {"a": 1}


@pytest.mark.asyncio
async def test_json_reply_returns_none_on_garbage(monkeypatch):
    _install_fake(monkeypatch, _text_reply("not json"))
    assert await llm_completion("sys", "user", json_reply=True) is None


@pytest.mark.asyncio
async def test_stream_yields_content_deltas(monkeypatch):
    class _Stream:
        def __aiter__(self):
            async def _gen():
                for piece in ("a", None, "b"):
                    yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=piece))])

            return _gen()

    _install_fake(monkeypatch, _Stream())
    generator = await llm_completion("sys", "user", stream=True)
    assert [chunk async for chunk in generator] == ["a", "b"]


@pytest.mark.asyncio
async def test_a_failing_request_answers_empty(monkeypatch):
    """A provider error is logged and answered empty, never raised at the caller."""

    class _Boom:
        def __init__(self, *_a, **_kw):
            self.chat = SimpleNamespace(completions=self)

        async def create(self, **_params):
            raise RuntimeError("boom")

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", lambda **_kw: _Boom())
    _install_keys(monkeypatch)
    assert await llm_completion("sys", "user") == ""


@pytest.mark.asyncio
async def test_a_missing_key_answers_empty_without_calling_out(monkeypatch):
    """No credential is a failure like any other at this layer, and never a request."""
    from flow_sdk.config import default_service_config

    monkeypatch.setattr(default_service_config, "openrouter_api_key", None, raising=False)
    assert await llm_completion("sys", "user") == ""


@pytest.mark.asyncio
async def test_the_primitive_raises_what_the_wrapper_swallows(monkeypatch):
    """``openai_compatible_completion`` reports failures; ``llm_completion`` absorbs them."""
    from flow_sdk.external_apis.llm.errors import LLMNoCredential
    from flow_sdk.external_apis.llm.simple_llm import openai_compatible_completion

    with pytest.raises(LLMNoCredential):
        await openai_compatible_completion(
            base_url="https://example.invalid/v1",
            api_key=None,
            model="vendor/model",
            system="sys",
            user="user",
        )


def test_unknown_prefix_falls_back_to_openrouter():
    assert parse_model_string("vendor/model") == (APIProvider.OPENROUTER, "vendor/model")
    with pytest.raises(ValueError):
        parse_model_string("bare")
    assert completion_module.APIProvider is APIProvider
