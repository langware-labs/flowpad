"""``LLMClient`` — the one place the box originates an LLM call.

Pins the three things that differ per provider (base URL, auth headers, wire protocol) and
the error contract that replaced the old swallow-everything primitive: every failure is a
typed exception carrying the upstream status, so a caller can tell a bad key from a quiet
model. No network — the OpenAI SDK class and ``httpx.AsyncClient`` are both faked.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from flow_sdk.external_apis.llm.client import LLMClient
from flow_sdk.external_apis.llm.dialects import (
    ANTHROPIC_VERSION_DEFAULT,
    OPENROUTER_REFERER,
    default_base_url_for,
    get_dialect,
)
from flow_sdk.external_apis.llm.errors import (
    LLMAuthError,
    LLMInvalidJSON,
    LLMNoCredential,
    LLMNotSupported,
    LLMRateLimited,
    LLMTimeout,
    LLMUpstreamError,
)

# ── fakes ────────────────────────────────────────────────────────────────────


class _FakeOpenAI:
    """Enough of ``AsyncOpenAI`` for chat and embeddings, recording what it was handed."""

    def __init__(self, recorder, *, reply=None, embedding_dims=3, error=None):
        self._recorder = recorder
        self._reply = reply
        self._dims = embedding_dims
        self._error = error
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._chat_create))
        self.embeddings = SimpleNamespace(create=self._embeddings_create)

    async def _chat_create(self, **params):
        self._recorder["params"] = params
        if self._error:
            raise self._error
        return self._reply

    async def _embeddings_create(self, *, model, input):
        self._recorder.setdefault("embedding_batches", []).append(list(input))
        self._recorder["embedding_model"] = model
        if self._error:
            raise self._error
        return SimpleNamespace(data=[SimpleNamespace(embedding=[0.1] * self._dims) for _ in input])


def _install_openai(monkeypatch, **kwargs):
    recorder: dict = {}

    def _factory(**client_kwargs):
        recorder.update(client_kwargs)
        return _FakeOpenAI(recorder, **kwargs)

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", _factory)
    return recorder


class _FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text or json.dumps(payload or {})

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


def _install_httpx(monkeypatch, response=None, raises=None):
    recorder: dict = {}

    class _FakeAsyncClient:
        def __init__(self, **kwargs):
            recorder["timeout"] = kwargs.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_exc):
            return False

        async def request(self, method, url, headers=None, json=None):
            recorder.update({"method": method, "url": url, "headers": headers or {}, "body": json})
            if raises is not None:
                raise raises
            return response

    import httpx

    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    return recorder


def _text_reply(text: str):
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))])


# ── dialects ─────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("provider", "base", "openai_base"),
    [
        ("openrouter", "https://openrouter.ai/api", "https://openrouter.ai/api/v1"),
        ("openai", "https://api.openai.com", "https://api.openai.com/v1"),
        ("anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1"),
    ],
)
def test_a_dialect_owns_the_base_url_and_adds_v1_once(provider, base, openai_base):
    dialect = get_dialect(provider)
    assert default_base_url_for(provider) == base
    assert dialect.openai_base() == openai_base
    # An already-suffixed URL is left alone rather than doubled — a hub invoke URL arrives
    # in that shape.
    assert dialect.openai_base(openai_base) == openai_base


def test_an_unknown_provider_names_the_ones_that_exist():
    with pytest.raises(ValueError, match="anthropic"):
        get_dialect("nope")


def test_auth_headers_differ_by_provider():
    assert get_dialect("openai").auth_headers("k") == {"authorization": "Bearer k"}
    openrouter = get_dialect("openrouter").auth_headers("k")
    assert openrouter["authorization"] == "Bearer k"
    assert openrouter["http-referer"] == OPENROUTER_REFERER
    assert get_dialect("anthropic").auth_headers("k") == {
        "x-api-key": "k",
        "anthropic-version": ANTHROPIC_VERSION_DEFAULT,
    }


# ── completions ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openrouter", "openai"])
async def test_openai_wire_completion_uses_the_configured_md_model(monkeypatch, provider):
    recorder = _install_openai(monkeypatch, reply=_text_reply("hello"))
    client = LLMClient.for_dialect(provider, api_key="k")
    assert await client.create_completion("sys", "user") == "hello"
    assert recorder["base_url"] == get_dialect(provider).openai_base()
    assert recorder["params"]["model"] == get_dialect(provider).default_models["md"]
    assert recorder["params"]["messages"][0]["content"] == "sys"


@pytest.mark.asyncio
async def test_an_explicit_model_beats_the_default(monkeypatch):
    recorder = _install_openai(monkeypatch, reply=_text_reply("hi"))
    client = LLMClient.for_dialect("openrouter", api_key="k")
    await client.create_completion("sys", "user", model="vendor/other")
    assert recorder["params"]["model"] == "vendor/other"


@pytest.mark.asyncio
async def test_the_anthropic_wire_posts_messages_not_chat_completions(monkeypatch):
    recorder = _install_httpx(
        monkeypatch, _FakeResponse(200, {"content": [{"type": "text", "text": "hi"}, {"type": "thinking"}]})
    )
    client = LLMClient.for_dialect("anthropic", api_key="k")
    assert await client.create_completion("sys", "user") == "hi"
    assert recorder["url"] == "https://api.anthropic.com/v1/messages"
    assert recorder["headers"]["x-api-key"] == "k"
    assert recorder["body"]["system"] == "sys"
    assert recorder["body"]["model"] == "claude-sonnet-4-5"


@pytest.mark.asyncio
async def test_json_reply_parses_a_fenced_object(monkeypatch):
    _install_openai(monkeypatch, reply=_text_reply('```json\n{"a": 1}\n```'))
    client = LLMClient.for_dialect("openrouter", api_key="k")
    assert await client.create_completion("sys", "user", json_reply=True) == {"a": 1}


@pytest.mark.asyncio
async def test_unparseable_json_is_its_own_error(monkeypatch):
    """Distinct from every other failure — the legacy wrapper answers ``None`` for this alone."""
    _install_openai(monkeypatch, reply=_text_reply("not json"))
    client = LLMClient.for_dialect("openrouter", api_key="k")
    with pytest.raises(LLMInvalidJSON):
        await client.create_completion("sys", "user", json_reply=True)


@pytest.mark.asyncio
async def test_streaming_yields_content_deltas(monkeypatch):
    class _Stream:
        def __aiter__(self):
            async def _gen():
                for piece in ("a", None, "b"):
                    yield SimpleNamespace(choices=[SimpleNamespace(delta=SimpleNamespace(content=piece))])

            return _gen()

    _install_openai(monkeypatch, reply=_Stream())
    client = LLMClient.for_dialect("openrouter", api_key="k")
    stream = await client.create_completion("sys", "user", stream=True)
    assert [chunk async for chunk in stream] == ["a", "b"]


# ── embeddings ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openrouter", "openai"])
async def test_embeddings_use_the_embedding_tier_and_keep_order(monkeypatch, provider):
    recorder = _install_openai(monkeypatch, embedding_dims=4)
    client = LLMClient.for_dialect(provider, api_key="k")
    vectors = await client.create_embeddings(["a", "b", "c"])
    assert len(vectors) == 3
    assert all(len(v) == 4 for v in vectors)
    assert recorder["embedding_model"] == get_dialect(provider).default_models["embedding"]
    assert recorder["embedding_batches"] == [["a", "b", "c"]]


@pytest.mark.asyncio
async def test_a_long_list_is_split_into_provider_sized_batches(monkeypatch):
    from flow_sdk.external_apis.llm.client import OPENAI_EMBEDDING_BATCH

    recorder = _install_openai(monkeypatch, embedding_dims=1)
    client = LLMClient.for_dialect("openai", api_key="k")
    texts = [f"t{i}" for i in range(OPENAI_EMBEDDING_BATCH + 5)]
    assert len(await client.create_embeddings(texts)) == len(texts)
    assert [len(batch) for batch in recorder["embedding_batches"]] == [OPENAI_EMBEDDING_BATCH, 5]


@pytest.mark.asyncio
async def test_an_empty_list_costs_nothing(monkeypatch):
    recorder = _install_openai(monkeypatch)
    client = LLMClient.for_dialect("openai", api_key="k")
    assert await client.create_embeddings([]) == []
    assert "embedding_batches" not in recorder


@pytest.mark.asyncio
async def test_anthropic_has_no_embeddings_api():
    """Not a transport failure — the provider has no such endpoint, and saying so is the point."""
    client = LLMClient.for_dialect("anthropic", api_key="k")
    with pytest.raises(LLMNotSupported):
        await client.create_embeddings(["a"])


# ── listing and probing ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_list_models_parses_the_shared_data_id_shape(monkeypatch):
    recorder = _install_httpx(monkeypatch, _FakeResponse(200, {"data": [{"id": "a"}, {"id": "b"}, {}]}))
    client = LLMClient.for_dialect("openrouter", api_key="k")
    assert await client.list_models() == ["a", "b"]
    assert recorder["url"] == "https://openrouter.ai/api/v1/models"


@pytest.mark.asyncio
async def test_only_openrouter_can_filter_its_catalog_by_modality(monkeypatch):
    recorder = _install_httpx(monkeypatch, _FakeResponse(200, {"data": [{"id": "openai/text-embedding-3-small"}]}))
    client = LLMClient.for_dialect("openrouter", api_key="k")
    await client.list_models(embeddings_only=True)
    assert recorder["url"].endswith("v1/models?output_modalities=embeddings")

    recorder = _install_httpx(monkeypatch, _FakeResponse(200, {"data": []}))
    await LLMClient.for_dialect("openai", api_key="k").list_models(embeddings_only=True)
    assert recorder["url"] == "https://api.openai.com/v1/models"


@pytest.mark.asyncio
async def test_an_unreadable_catalog_is_empty_not_an_error(monkeypatch):
    _install_httpx(monkeypatch, _FakeResponse(500, text="boom"))
    assert await LLMClient.for_dialect("openai", api_key="k").list_models() == []


@pytest.mark.asyncio
async def test_probe_hits_openrouters_dedicated_key_route(monkeypatch):
    recorder = _install_httpx(monkeypatch, _FakeResponse(200, {"data": {"limit": None}}))
    result = await LLMClient.for_dialect("openrouter", api_key="k").probe()
    assert result.ok is True
    assert recorder["url"] == "https://openrouter.ai/api/v1/key"


@pytest.mark.asyncio
async def test_probe_reports_a_rejected_key_without_raising(monkeypatch):
    _install_httpx(monkeypatch, _FakeResponse(401, text="bad key"))
    result = await LLMClient.for_dialect("openai", api_key="k").probe()
    assert result.ok is False
    assert result.status == 401
    assert "401" in result.message


@pytest.mark.asyncio
async def test_probe_without_a_key_says_so_and_makes_no_request(monkeypatch):
    recorder = _install_httpx(monkeypatch, _FakeResponse(200, {"data": []}))
    result = await LLMClient.for_dialect("openai", api_key=None).probe()
    assert (result.ok, result.message) == (False, "No key configured")
    assert recorder == {}


# ── the error contract ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_no_credential_is_refused_before_any_request(monkeypatch):
    recorder = _install_openai(monkeypatch, reply=_text_reply("hi"))
    client = LLMClient.for_dialect("openai", api_key=None)
    with pytest.raises(LLMNoCredential):
        await client.create_completion("sys", "user")
    assert recorder == {}


@pytest.mark.asyncio
async def test_an_endpoint_with_no_model_for_the_tier_says_which_tier(monkeypatch):
    _install_openai(monkeypatch, reply=_text_reply("hi"))
    client = LLMClient.for_dialect("openai", api_key="k", models={})
    with pytest.raises(Exception, match="no embedding model"):
        await client.create_embeddings(["a"])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "expected"),
    [(401, LLMAuthError), (403, LLMAuthError), (429, LLMRateLimited), (500, LLMUpstreamError)],
)
async def test_upstream_status_becomes_a_typed_error(monkeypatch, status, expected):
    class _Boom(Exception):
        def __init__(self):
            super().__init__("upstream said no")
            self.status_code = status
            self.body = "detail"

    _install_openai(monkeypatch, error=_Boom())
    client = LLMClient.for_dialect("openai", api_key="k")
    with pytest.raises(expected) as caught:
        await client.create_completion("sys", "user")
    assert caught.value.status == status


@pytest.mark.asyncio
async def test_a_timeout_is_a_timeout_not_an_empty_answer(monkeypatch):
    import asyncio

    class _Hang:
        def __init__(self, *_a, **_kw):
            self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

        async def _create(self, **_params):
            await asyncio.sleep(5)

    import openai

    monkeypatch.setattr(openai, "AsyncOpenAI", lambda **_kw: _Hang())
    client = LLMClient.for_dialect("openai", api_key="k")
    with pytest.raises(LLMTimeout):
        await client.create_completion("sys", "user", timeout=0.01)


@pytest.mark.asyncio
async def test_a_transport_failure_is_reported_not_swallowed(monkeypatch):
    import httpx

    _install_httpx(monkeypatch, raises=httpx.ConnectError("no route"))
    with pytest.raises(LLMUpstreamError):
        await LLMClient.for_dialect("anthropic", api_key="k").create_completion("s", "u")
