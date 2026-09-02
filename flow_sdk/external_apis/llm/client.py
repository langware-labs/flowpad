"""One LLM client, told what to be by a :class:`ProviderDialect`.

This is the single place the box originates an LLM call. It is a plain object rather than a
mixin on ``LLMEndpoint`` for three reasons: the entity module must not import ``openai`` at
import time, a client is constructible with no database at all (which is what makes
``LLMEndpoint(provider="openrouter").create_embeddings([...])`` work), and the hub — which
already owns the dialect table this ports — could reuse it unchanged.

**The base URL held here is the ROOT**, without ``/v1``. Each transport appends what it
needs: the OpenAI SDK wants the ``/v1`` form, a raw sub-path call wants to join ``v1/...``
onto the root. Storing the SDK form instead meant appending ``/v1`` on construction and
stripping it again on every raw call. Both joins are idempotent, so a hub invoke URL that
already carries ``/v1`` arrives here unharmed.

Every failure raises (:mod:`flow_sdk.external_apis.llm.errors`). The empty-string convention
the old primitive used lives on only in the two callers that always wanted it.
"""

from __future__ import annotations

import asyncio
import json as json_module
import logging
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Mapping, Sequence

from flow_sdk.external_apis.llm.dialects import WIRE_ANTHROPIC, ProviderDialect, get_dialect
from flow_sdk.external_apis.llm.errors import (
    LLMError,
    LLMInvalidJSON,
    LLMNoCredential,
    LLMNotSupported,
    LLMTimeout,
    LLMUpstreamError,
    raise_for_openai,
)
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider

logger = logging.getLogger(__name__)

#: OpenAI's per-request cap on embedding inputs. Larger lists are split and fanned out.
OPENAI_EMBEDDING_BATCH = 2048

#: How long a probe or a model listing may take. A ceiling on one HTTP GET that either
#: answers or does not — never widened to ride past a symptom.
PROBE_TIMEOUT_SECONDS = 10.0

#: How many embedding batches may be in flight at once. Not a timeout and not a retry: a
#: corpus of 100k chunks is 49 batches, and firing all of them concurrently earns a 429 from
#: the provider rather than going faster.
EMBEDDING_CONCURRENCY = 4


@dataclass(frozen=True)
class ProbeResult:
    """What a credential probe found. ``message`` is rendered verbatim to the user."""

    ok: bool
    status: int | None = None
    message: str = ""


class LLMClient:
    """Completions, embeddings, model listings and probes against one endpoint."""

    def __init__(
        self,
        *,
        dialect: ProviderDialect,
        base_url: str,
        api_key: str | None,
        models: Mapping[str, str] | None = None,
        extra_headers: Mapping[str, str] | None = None,
        label: str = "",
    ) -> None:
        self.dialect = dialect
        #: The root. ``/v1`` is applied per transport, never stored.
        self.base_url = base_url or dialect.default_base_url
        self.api_key = api_key
        self.models = dict(models or {})
        self.extra_headers = dict(extra_headers or {})
        self.label = label or dialect.provider.value
        #: Built once per client. A fresh ``AsyncOpenAI`` rebuilds the TLS context and reloads
        #: the CA bundle from disk; ``cloud_client/transport/hub_http.py`` measured that at
        #: ~40% of a request, and an embedder calls this per query.
        self._sdk_client: Any = None

    @classmethod
    def for_dialect(
        cls,
        provider: LMApiProvider | str,
        *,
        api_key: str | None,
        base_url: str = "",
        models: Mapping[str, str] | None = None,
        extra_headers: Mapping[str, str] | None = None,
        label: str = "",
    ) -> "LLMClient":
        """Build a client for a provider, letting the dialect supply the base URL and models."""
        dialect = get_dialect(provider)
        return cls(
            dialect=dialect,
            base_url=base_url,
            api_key=api_key,
            models=models if models is not None else dict(dialect.default_models),
            extra_headers=extra_headers,
            label=label,
        )

    # ── credentials ─────────────────────────────────────────────────────────

    def _require_key(self) -> str:
        if not self.api_key:
            raise LLMNoCredential(f"{self.label}: no API key is available for this endpoint")
        return self.api_key

    def _model_for(self, model: str | None, tier: str) -> str:
        chosen = model or self.models.get(tier) or ""
        if not chosen:
            raise LLMError(f"{self.label}: no {tier} model is configured for this endpoint")
        return chosen

    # ── completions ─────────────────────────────────────────────────────────

    async def create_completion(
        self,
        system: str,
        user: str,
        *,
        model: str | None = None,
        stream: bool = False,
        json_reply: bool = False,
        reasoning: bool = False,
        timeout: float = 60.0,
    ) -> "str | dict | AsyncGenerator[str, None]":
        """One chat turn. Returns text, parsed JSON, or a stream of text chunks."""
        slug = self._model_for(model, "md")
        if self.dialect.wire == WIRE_ANTHROPIC:
            if stream:
                raise LLMNotSupported(f"{self.label}: streaming is not implemented for the Anthropic wire")
            return await self._anthropic_completion(system, user, model=slug, json_reply=json_reply, timeout=timeout)
        return await self._openai_completion(
            system, user, model=slug, stream=stream, json_reply=json_reply, reasoning=reasoning, timeout=timeout
        )

    async def _openai_completion(
        self, system: str, user: str, *, model: str, stream: bool, json_reply: bool, reasoning: bool, timeout: float
    ) -> "str | dict | AsyncGenerator[str, None]":
        from openai.types.chat import (  # noqa: PLC0415
            ChatCompletionSystemMessageParam,
            ChatCompletionUserMessageParam,
        )

        client = self._openai_client()
        params: dict = {
            "model": model,
            "messages": [
                ChatCompletionSystemMessageParam(role="system", content=system),
                ChatCompletionUserMessageParam(role="user", content=user),
            ],
            "stream": stream,
        }
        if reasoning:
            # An OpenRouter-ism, harmless elsewhere: unknown extra_body keys are ignored.
            params["extra_body"] = {"reasoning": {"effort": "high"}}

        response = await self._await_upstream(client.chat.completions.create(**params), timeout=timeout)

        if stream:
            return self._stream(response)
        text = response.choices[0].message.content or ""
        return self._as_json(text) if json_reply else text

    async def _anthropic_completion(
        self, system: str, user: str, *, model: str, json_reply: bool, timeout: float
    ) -> "str | dict":
        body = {
            "model": model,
            "max_tokens": 4096,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        payload = await self._request_json("POST", "v1/messages", json_body=body, timeout=timeout)
        parts = payload.get("content") if isinstance(payload, dict) else None
        text = ""
        if isinstance(parts, list):
            text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
        return self._as_json(text) if json_reply else text

    async def _stream(self, response: Any) -> "AsyncGenerator[str, None]":
        try:
            async for chunk in response:
                task = asyncio.current_task()
                if task is not None and task.cancelled():
                    logger.info("LLM streaming cancelled")
                    return
                content = getattr(chunk.choices[0].delta, "content", None)
                if content:
                    yield content
        except asyncio.CancelledError:
            logger.info("LLM streaming cancelled via CancelledError")
            raise

    def _as_json(self, text: str) -> dict:
        from flow_sdk.external_apis.llm.utils.utils import clean_fenced_completion  # noqa: PLC0415

        cleaned = clean_fenced_completion(text)
        try:
            return json_module.loads(cleaned)
        except json_module.JSONDecodeError as exc:
            raise LLMInvalidJSON(f"{self.label}: reply was not valid JSON: {exc}", body=cleaned[:500]) from exc

    # ── embeddings ──────────────────────────────────────────────────────────

    async def create_embeddings(
        self, texts: Sequence[str], *, model: str | None = None, timeout: float = 60.0
    ) -> list[list[float]]:
        """Embed each text, preserving order. One request per ``OPENAI_EMBEDDING_BATCH`` inputs."""
        if not self.dialect.supports_embeddings:
            raise LLMNotSupported(f"{self.label}: this provider has no embeddings API")
        items = list(texts)
        if not items:
            return []
        slug = self._model_for(model, "embedding")
        client = self._openai_client()
        batches = [items[i : i + OPENAI_EMBEDDING_BATCH] for i in range(0, len(items), OPENAI_EMBEDDING_BATCH)]
        gate = asyncio.Semaphore(EMBEDDING_CONCURRENCY)

        async def _embed(batch: list[str]) -> Any:
            async with gate:
                return await client.embeddings.create(model=slug, input=batch)

        # ``timeout`` still covers the WHOLE call, not each batch: a per-batch ceiling would
        # quietly multiply the caller's budget by the number of batches.
        results = await self._await_upstream(
            asyncio.gather(*(_embed(batch) for batch in batches)), timeout=timeout
        )
        out: list[list[float]] = []
        for result in results:
            out.extend(item.embedding for item in result.data)
        return out

    # ── listing and probing ─────────────────────────────────────────────────

    async def list_models(self, *, embeddings_only: bool = False) -> list[str]:
        """Every model slug this endpoint will accept, or ``[]`` when the catalog is unreadable."""
        path = self.dialect.models_probe_path
        if embeddings_only and self.dialect.provider is LMApiProvider.OPENROUTER:
            # OpenRouter is the only catalog that can filter; elsewhere the caller filters.
            path = f"{path}?output_modalities=embeddings"
        try:
            payload = await self._request_json("GET", path, timeout=PROBE_TIMEOUT_SECONDS)
        except LLMError:
            return []
        return self.dialect.parse_models(payload)

    async def probe(self) -> ProbeResult:
        """Ask the provider whether this credential works. Never raises."""
        if not self.api_key:
            return ProbeResult(ok=False, message="No key configured")
        try:
            await self._request_json("GET", self.dialect.key_probe_path, timeout=PROBE_TIMEOUT_SECONDS)
        except LLMError as exc:
            return ProbeResult(ok=False, status=exc.status, message=exc.message)
        return ProbeResult(ok=True, status=200, message="Key is valid")

    # ── transport ───────────────────────────────────────────────────────────

    def _openai_client(self) -> Any:
        from openai import AsyncOpenAI  # noqa: PLC0415

        key = self._require_key()
        if self._sdk_client is not None:
            return self._sdk_client
        # ``default_headers`` passed only when non-empty: the plain two-argument construction
        # is what the shared primitive has always used, and callers' fakes are built for it.
        base_url = self.dialect.openai_base(self.base_url)
        if self.extra_headers:
            self._sdk_client = AsyncOpenAI(base_url=base_url, api_key=key, default_headers=dict(self.extra_headers))
        else:
            self._sdk_client = AsyncOpenAI(base_url=base_url, api_key=key)
        return self._sdk_client

    async def _request_json(
        self, method: str, sub_path: str, *, json_body: dict | None = None, timeout: float
    ) -> Any:
        """One authenticated HTTP call against this endpoint, decoded. Raises on any failure."""
        import httpx  # noqa: PLC0415

        headers = dict(self.extra_headers)
        if self.api_key:
            headers.update(self.dialect.auth_headers(self.api_key))
        elif json_body is not None or self.dialect.models_probe_needs_key:
            # A write always needs a credential; a public catalog (OpenRouter's) does not.
            self._require_key()
        url = self.dialect.url_for(sub_path, self.base_url)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.request(method, url, headers=headers, json=json_body)
        except httpx.TimeoutException as exc:
            raise LLMTimeout(f"{self.label}: request to {sub_path} timed out after {timeout}s") from exc
        except httpx.HTTPError as exc:
            raise LLMUpstreamError(f"{self.label}: {exc}") from exc
        if response.status_code >= 400:
            raise self._status_error(response.status_code, response.text)
        try:
            return response.json()
        except ValueError as exc:
            raise LLMUpstreamError(f"{self.label}: {sub_path} did not answer JSON", status=response.status_code) from exc

    def _status_error(self, status: int, body: str) -> LLMError:
        from flow_sdk.external_apis.llm.errors import LLMAuthError, LLMRateLimited  # noqa: PLC0415

        message = f"{self.label}: upstream returned {status}"
        trimmed = body[:500]
        if status in (401, 403):
            return LLMAuthError(message, status=status, body=trimmed)
        if status == 429:
            return LLMRateLimited(message, status=status, body=trimmed)
        return LLMUpstreamError(message, status=status, body=trimmed)

    async def _await_upstream(self, awaitable: Any, *, timeout: float) -> Any:
        """Await one SDK call under a ceiling, translating its failures into ours."""
        try:
            return await asyncio.wait_for(awaitable, timeout=timeout)
        except asyncio.TimeoutError as exc:
            raise LLMTimeout(f"{self.label}: completion timed out after {timeout} seconds") from exc
        except asyncio.CancelledError:
            raise
        except LLMError:
            raise
        except Exception as exc:  # noqa: BLE001 — every SDK failure becomes one of ours
            raise raise_for_openai(exc, label=self.label) from exc


__all__ = ["LLMClient", "OPENAI_EMBEDDING_BATCH", "PROBE_TIMEOUT_SECONDS", "ProbeResult"]
