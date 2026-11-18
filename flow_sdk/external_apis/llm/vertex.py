"""Vertex's project-scoped routes and refreshed Google authentication.

Adapted from the hub's Vertex adapter: callers keep the normal endpoint API;
provider routing and credential material never escape this boundary.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from typing import Any

import httpx

from flow_sdk.external_apis.llm.client import PROBE_TIMEOUT_SECONDS, LLMClient, ProbeResult
from flow_sdk.external_apis.llm.errors import LLMAuthError, LLMError, LLMNotSupported, LLMTimeout, LLMUpstreamError
from flow_sdk.schema.data_spec.llm_model_spec import LLMModelInfo, VertexConfig

DEFAULT_BASE = "https://aiplatform.googleapis.com/v1"
DEFAULT_MODELS = {
    "sm": "google/gemini-3.1-flash-lite",
    "md": "google/gemini-3.5-flash",
    "lg": "google/gemini-3.1-pro-preview",
}
MODELS = (
    *DEFAULT_MODELS.values(),
    "google/gemini-2.5-flash",
    "google/gemini-2.5-pro",
    "claude-sonnet-4-6",
    "claude-opus-4-6",
    "claude-haiku-4-5@20251001",
)
_credentials: dict[str, Any] = {}
_refreshes: dict[tuple[Any, str], asyncio.Task] = {}


def service_account(credential: str) -> dict:
    """Validate stored JSON without network access or secret-bearing diagnostics."""
    if not credential.lstrip().startswith("{"):
        raise LLMNotSupported("Vertex raw API keys are not supported locally; provide service-account JSON")
    try:
        info = json.loads(credential)
        if (
            not isinstance(info, dict)
            or info.get("type") != "service_account"
            or info.get("token_uri") != "https://oauth2.googleapis.com/token"
        ):
            raise ValueError
        from google.oauth2 import service_account as google_service_account

        google_service_account.Credentials.from_service_account_info(
            info, scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        return info
    except Exception:
        raise LLMAuthError("Vertex requires valid service-account JSON with a signing key") from None


def canonical_config(
    base_url: str, config: VertexConfig | None = None, credential: str = ""
) -> tuple[str, VertexConfig]:
    config = config or VertexConfig()
    info = service_account(credential) if credential else {}
    root = (base_url or DEFAULT_BASE).rstrip("/")
    match = re.fullmatch(
        r"https://(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com/v1/projects/([a-zA-Z0-9_.:-]+)/locations/([a-z0-9-]+)",
        root,
    )
    if root != DEFAULT_BASE and not match:
        raise ValueError("Vertex base URL must identify a Google project and location")
    project, location = (match.group(1), match.group(2)) if match else ("", "")
    if (config.project_id and project and config.project_id != project) or (
        config.location and location and config.location != location
    ):
        raise ValueError("Vertex project/location conflicts with the base URL")
    project = config.project_id or project or str(info.get("project_id") or "")
    location = config.location or location or "global"
    if not re.fullmatch(r"[a-zA-Z0-9_.:-]+", project) or not re.fullmatch(r"[a-z0-9-]+", location):
        raise ValueError("Vertex requires a valid project ID and location")
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    return f"https://{host}/v1/projects/{project}/locations/{location}", VertexConfig(
        project_id=project, location=location
    )


def is_claude(model: str) -> bool:
    return model.rpartition("/")[2].startswith("claude-")


def vertex_model(model: str) -> str:
    vendor, slash, bare = model.partition("/")
    if not slash:
        vendor, bare = "", model
    if is_claude(model):
        name, at, pin = bare.partition("@")
        return (name if at else name.replace(".", "-")) + at + pin
    if not vendor:
        return f"google/{bare}" if bare.startswith("gemini-") else bare
    publisher = {"z-ai": "zai-org"}.get(vendor, vendor)
    if publisher in {
        "zai-org",
        "openai",
        "meta",
        "deepseek-ai",
        "qwen",
        "moonshotai",
        "minimaxai",
    } and not bare.endswith("-maas"):
        bare += "-maas"
    return f"{publisher}/{bare}"


def route(model: str, body: dict, *, stream: bool) -> tuple[str, dict]:
    model = vertex_model(model)
    if not re.fullmatch(r"[a-zA-Z0-9_./@-]+", model) or ".." in model:
        raise LLMNotSupported("Invalid Vertex model ID")
    if is_claude(model):
        path = f"publishers/anthropic/models/{model}:{'streamRawPredict' if stream else 'rawPredict'}"
        return path, {**body, "anthropic_version": "vertex-2023-10-16"}
    if "/" not in model:
        raise LLMNotSupported("Vertex chat needs a publisher/model ID")
    return "endpoints/openapi/chat/completions", {**body, "model": model}


async def access_token(credential: str) -> str:
    fingerprint = hashlib.sha256(credential.encode()).hexdigest()
    loop_key = (asyncio.get_running_loop(), fingerprint)
    creds = _credentials.get(fingerprint)
    if creds is None:
        from google.oauth2 import service_account as google_service_account

        creds = google_service_account.Credentials.from_service_account_info(
            service_account(credential), scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        _credentials[fingerprint] = creds
    refresh = _refreshes.get(loop_key)
    if refresh is None and not creds.valid:

        async def renew():
            from google.auth.transport.requests import Request

            request = Request()
            try:
                await asyncio.to_thread(
                    creds.refresh,
                    lambda *args, **kwargs: request(*args, **{**kwargs, "timeout": PROBE_TIMEOUT_SECONDS}),
                )
            except Exception:
                raise LLMAuthError("Vertex service-account authentication failed") from None

        def finished(task):
            if _refreshes.get(loop_key) is task:
                _refreshes.pop(loop_key, None)
            if not task.cancelled():
                task.exception()  # A cancelled waiter must not leave an unobserved exception.

        refresh = asyncio.create_task(renew())
        _refreshes[loop_key] = refresh
        refresh.add_done_callback(finished)
    if refresh is not None:
        await asyncio.shield(refresh)  # The refresh, not an individual caller, owns singleflight.
    return str(creds.token)


class VertexClient(LLMClient):
    """The same endpoint operations with Vertex's model-dependent transport."""

    async def list_models(self, *, embeddings_only: bool = False) -> list[str]:
        return [] if embeddings_only else list(dict.fromkeys((*MODELS, *self.models.values())))

    async def model_catalog(self) -> list[LLMModelInfo]:
        return [
            LLMModelInfo(id=m, name=m, formats=["messages" if is_claude(m) else "chat"], catalog_source="declared")
            for m in await self.list_models()
        ]

    async def create_embeddings_with_model(self, texts, *, model=None, timeout=60.0):
        raise LLMNotSupported("Vertex embeddings are not implemented by this adapter")

    async def probe(self) -> ProbeResult:
        try:
            await self.test_completion()
            return ProbeResult(ok=True, status=200, message="Vertex model invocation succeeded")
        except LLMError as exc:
            return ProbeResult(ok=False, status=exc.status, message=exc.message)

    async def test_completion(self, *, timeout: float = PROBE_TIMEOUT_SECONDS) -> None:
        await self._await_upstream(
            self._complete(
                "",
                "hi",
                model=self.models.get("sm") or self._model_for(None, "md"),
                stream=False,
                max_tokens=1,
                timeout=timeout,
            ),
            timeout=timeout,
        )

    async def create_completion(
        self, system, user, *, model=None, stream=False, json_reply=False, reasoning=False, timeout=60.0
    ):
        if json_reply:
            system = f"{system}\nReturn only a valid JSON value, without Markdown fences.".strip()
        result = await self._await_upstream(
            self._complete(
                system, user, model=await self._completion_model(model), stream=stream, max_tokens=4096, timeout=timeout
            ),
            timeout=timeout,
        )
        return self._as_json(result) if json_reply and not stream else result

    async def _complete(self, system, user, *, model, stream, max_tokens, timeout):
        credential = self._require_key()
        try:
            base, _ = canonical_config(self.base_url, credential=credential)
        except ValueError as exc:
            raise LLMNotSupported(str(exc)) from None
        anthropic = is_claude(model)
        messages = [{"role": "user", "content": user}]
        body = {"messages": messages, "max_tokens": max_tokens, "stream": stream}
        if system:
            if anthropic:
                body["system"] = system
            else:
                messages.insert(0, {"role": "system", "content": system})
        path, body = route(model, body, stream=stream)
        headers = {"authorization": f"Bearer {await access_token(credential)}"}
        if stream:
            return self._vertex_stream(f"{base}/{path}", headers, body, timeout, anthropic)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.post(f"{base}/{path}", headers=headers, json=body)
            if response.status_code >= 400:
                raise self._status_error(response.status_code, response.text)
            data = response.json()
            if anthropic:
                return "".join(p.get("text", "") for p in data.get("content", []) if p.get("type") == "text")
            return data["choices"][0]["message"].get("content") or ""
        except httpx.TimeoutException:
            raise LLMTimeout("Vertex request timed out") from None
        except (httpx.HTTPError, ValueError, KeyError, IndexError):
            raise LLMUpstreamError("Vertex returned an invalid completion response") from None

    async def _vertex_stream(self, url, headers, body, timeout, anthropic):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream("POST", url, headers=headers, json=body) as response:
                    if response.status_code >= 400:
                        await response.aread()
                        raise self._status_error(response.status_code, response.text)
                    async for line in response.aiter_lines():
                        if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                            continue
                        data = json.loads(line[5:])
                        if data.get("type") == "error" or data.get("error"):
                            raise LLMUpstreamError("Vertex stream reported an upstream error")
                        if anthropic:
                            text = data.get("delta", {}).get("text", "")
                        else:
                            choices = data.get("choices") or []
                            text = (choices[0].get("delta") or {}).get("content") if choices else None
                        if text:
                            yield text
        except httpx.TimeoutException:
            raise LLMTimeout("Vertex stream timed out") from None
        except (httpx.HTTPError, ValueError):
            raise LLMUpstreamError("Vertex returned an invalid stream") from None
