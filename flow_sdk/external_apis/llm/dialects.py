"""Provider dialects: the few things that differ between OpenRouter, Anthropic and OpenAI.

Pure — no I/O, no entity imports. A ``ProviderDialect`` knows how a provider authenticates,
where its model list lives, how that list is parsed, which wire protocol it speaks, where its
key comes from when nobody stored one, and which model slugs to reach for by default.

This is a port of the hub's ``flowpad/hub/core/llm/providers.py``, kept name-for-name
(``DIALECTS``, ``get_dialect``, ``default_base_url_for``, ``api_flavor_for``, ``error_shape``)
so a later hub release can import this module instead of keeping its own copy. The additions
are the four fields the hub has no use for — it never *originates* a call, it proxies one:
``wire``, ``env_var``/``config_attr``, ``supports_embeddings`` and ``default_models``.

**Base URLs carry no** ``/v1``, matching the hub. The ``/v1`` belongs to the sub-path, so
``openai_base()`` is the one place that joins them; a base_url that already ends in ``/v1``
is left alone rather than doubled.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider

ANTHROPIC_VERSION_DEFAULT = "2023-06-01"
OPENROUTER_REFERER = "https://flowpad.ai"
OPENROUTER_TITLE = "FlowPad"

#: Wire protocols a dialect can speak. ``openai`` covers chat completions, embeddings and the
#: model list; ``anthropic`` covers ``v1/messages`` and has no embeddings endpoint at all.
WIRE_OPENAI = "openai"
WIRE_ANTHROPIC = "anthropic"


def _bearer(key: str, incoming: Mapping[str, str] | None = None) -> dict[str, str]:
    return {"authorization": f"Bearer {key}"}


def _openrouter_auth(key: str, incoming: Mapping[str, str] | None = None) -> dict[str, str]:
    out = _bearer(key, incoming)
    out["http-referer"] = OPENROUTER_REFERER
    out["x-title"] = OPENROUTER_TITLE
    return out


def _anthropic_auth(key: str, incoming: Mapping[str, str] | None = None) -> dict[str, str]:
    version = ANTHROPIC_VERSION_DEFAULT
    for name, value in (incoming or {}).items():
        if name.lower() == "anthropic-version" and value:
            version = value
            break
    return {"x-api-key": key, "anthropic-version": version}


def _parse_data_ids(json_body: Any) -> list[str]:
    """``{"data": [{"id": ...}, ...]}`` -> ids; anything else -> ``[]``."""
    if not isinstance(json_body, Mapping):
        return []
    data = json_body.get("data")
    if not isinstance(data, list):
        return []
    ids: list[str] = []
    for item in data:
        if isinstance(item, Mapping):
            model_id = item.get("id")
            if isinstance(model_id, str) and model_id:
                ids.append(model_id)
    return ids


def api_flavor_for(sub_path: str) -> str:
    """The API family a sub-path speaks: ``messages`` (Anthropic, ``v1/messages*``), ``responses``
    (OpenAI Responses, ``*responses*``), else ``chat`` (OpenAI-shaped: chat completions, models,
    embeddings)."""
    path = sub_path.strip("/")
    if path.startswith("v1/messages"):
        return "messages"
    if "responses" in path:
        return "responses"
    return "chat"


def error_shape(sub_path: str, status: int, err_type: str, message: str) -> dict[str, Any]:
    """The error body a caller of ``sub_path`` expects: Anthropic-shaped for ``v1/messages*``,
    else OpenAI."""
    if api_flavor_for(sub_path) == "messages":
        return {"type": "error", "error": {"type": err_type, "message": message}}
    return {"error": {"message": message, "type": err_type, "code": status}}


@dataclass(frozen=True)
class ProviderDialect:
    """Everything provider-specific about talking to one upstream, as data."""

    provider: LMApiProvider
    default_base_url: str
    _auth: Callable[..., dict[str, str]] = field(repr=False)
    #: Which client speaks to it. See ``WIRE_*``.
    wire: str = WIRE_OPENAI
    models_probe_path: str = "v1/models"
    #: What a key probe hits. OpenRouter answers a dedicated ``v1/key`` that reports the key's
    #: own limits; the others prove a key by listing models.
    key_probe_path: str = "v1/models"
    #: Whether the probe needs a credential at all. OpenRouter's catalog is public.
    models_probe_needs_key: bool = True
    env_var: str = ""
    config_attr: str = ""
    supports_embeddings: bool = True
    #: ``{sm, md, lg, embedding}`` — the slugs used when nobody chose one.
    default_models: Mapping[str, str] = field(default_factory=dict)
    _parse_models: Callable[[Any], list[str]] = field(default=_parse_data_ids, repr=False)

    def auth_headers(self, key: str, incoming: Mapping[str, str] | None = None) -> dict[str, str]:
        """Lower-cased header names; replaces whatever credential the caller sent."""
        return self._auth(key, incoming)

    def parse_models(self, json_body: Any) -> list[str]:
        return self._parse_models(json_body)

    def openai_base(self, base_url: str = "") -> str:
        """The URL an OpenAI-wire client wants: the base with exactly one ``/v1``."""
        root = (base_url or self.default_base_url).rstrip("/")
        return root if root.endswith("/v1") else f"{root}/v1"

    def url_for(self, sub_path: str, base_url: str = "") -> str:
        """Absolute URL for a ``v1/...`` sub-path against this dialect's root."""
        root = (base_url or self.default_base_url).rstrip("/")
        return f"{root}/{sub_path.lstrip('/')}"


DIALECTS: dict[LMApiProvider, ProviderDialect] = {
    LMApiProvider.OPENROUTER: ProviderDialect(
        provider=LMApiProvider.OPENROUTER,
        default_base_url="https://openrouter.ai/api",
        _auth=_openrouter_auth,
        key_probe_path="v1/key",
        models_probe_needs_key=False,
        env_var="OPENROUTER_API_KEY",
        config_attr="openrouter_api_key",
        default_models={
            # The slugs proven against OpenRouter for the CLI harnesses
            # (``cli_drivers/api_auth.py``), so one catalog serves both.
            "sm": "anthropic/claude-haiku-4.5",
            "md": "anthropic/claude-sonnet-4.5",
            "lg": "anthropic/claude-opus-4.1",
            # Priced by the hub's ``genai_prices`` table through its vendor fallback, so a
            # cost-limited hub endpoint can meter it. A ``:free`` model cannot be priced and
            # would be refused there — do not default to one.
            "embedding": "openai/text-embedding-3-small",
        },
    ),
    LMApiProvider.ANTHROPIC: ProviderDialect(
        provider=LMApiProvider.ANTHROPIC,
        default_base_url="https://api.anthropic.com",
        _auth=_anthropic_auth,
        wire=WIRE_ANTHROPIC,
        env_var="ANTHROPIC_API_KEY",
        config_attr="anthropic_api_key",
        supports_embeddings=False,
        default_models={
            # Vendor-direct spelling is dashed, unlike the dotted OpenRouter slugs.
            "sm": "claude-haiku-4-5",
            "md": "claude-sonnet-4-5",
            "lg": "claude-opus-4-1",
        },
    ),
    LMApiProvider.OPENAI: ProviderDialect(
        provider=LMApiProvider.OPENAI,
        default_base_url="https://api.openai.com",
        _auth=_bearer,
        env_var="OPENAI_API_KEY",
        config_attr="openai_api_key",
        default_models={
            "sm": "gpt-5-mini",
            "md": "gpt-5",
            "lg": "gpt-5-pro",
            "embedding": "text-embedding-3-small",
        },
    ),
}


def get_dialect(provider: LMApiProvider | str) -> ProviderDialect:
    """The dialect for ``provider``; ``ValueError`` on anything not in the registry."""
    key = provider if isinstance(provider, LMApiProvider) else str(provider)
    try:
        return DIALECTS[LMApiProvider(key)]
    except (ValueError, KeyError):
        raise ValueError(f"unknown LLM provider {key!r}; known providers are {sorted(p.value for p in DIALECTS)}")


def default_base_url_for(provider: LMApiProvider | str) -> str:
    return get_dialect(provider).default_base_url


__all__ = [
    "ANTHROPIC_VERSION_DEFAULT",
    "DIALECTS",
    "OPENROUTER_REFERER",
    "OPENROUTER_TITLE",
    "WIRE_ANTHROPIC",
    "WIRE_OPENAI",
    "ProviderDialect",
    "api_flavor_for",
    "default_base_url_for",
    "error_shape",
    "get_dialect",
]
