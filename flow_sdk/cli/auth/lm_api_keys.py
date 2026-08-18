"""LLM-provider API keys — provider-aware wrappers over the app-secret store.

Each provider key is written to the per-instance encrypted ``sod`` store (via
``secrets.py``) under a namespaced name ``lm_api.<provider>``, keeping LM keys an
enumerable set addressable by provider. In-process callers (a worker at spawn)
read them via :func:`get_lm_api`; :func:`list_lm_api` never returns a value.

The ``lm_api.`` prefix is a naming convention over the shared flat secret
keyspace, not an enforced reservation — a user secret named ``lm_api.*`` shares
the namespace.

``LMApiProvider.FLOWPAD`` is the exception to all of the above: its "key" is the
hub login key the box already holds, usable only while the hub has bound this
instance to one of its ``LLMEndpoint``s (``instance_settings/llm_endpoint.py``).
Nothing is stored for it, so ``set_lm_api`` refuses it and ``delete_lm_api`` is a
no-op — the hub owns that binding.
"""

from __future__ import annotations

from typing import Callable

from flow_sdk.cli.auth.secrets import delete_secret, get_secrets, read_secret, write_secret
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider

_PREFIX = "lm_api."


def _sod_name(provider: LMApiProvider | str) -> str:
    return f"{_PREFIX}{LMApiProvider(provider).value}"


def _hub_key_if_bound() -> str | None:
    """The FLOWPAD provider's key: the hub login key, iff the hub bound an endpoint."""
    from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415
    from flow_sdk.instance_settings.llm_endpoint import get_hub_llm_endpoint  # noqa: PLC0415

    return resolve_hub_api_key() if get_hub_llm_endpoint() else None


def _flowpad_probe() -> tuple[str, Callable[[str], dict[str, str]]] | None:
    """``(url, build_headers)`` for the bound hub endpoint's ``GET /v1/models`` --
    the one probe both key validation and the model catalog use for FLOWPAD (the
    upstream answers it, the hub passes it through, so a 200 proves login key +
    binding + upstream). ``None`` while unbound."""
    from flow_sdk.instance_settings.llm_endpoint import hub_llm_endpoint_invoke_url  # noqa: PLC0415

    invoke_url = hub_llm_endpoint_invoke_url()
    return (f"{invoke_url}/v1/models", _bearer) if invoke_url else None


def _bearer(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def set_lm_api(key: str, provider: LMApiProvider | str) -> None:
    """Store *key* for *provider* in the standard secret store (in-process).

    Overwrites any existing key for the provider. Requires the secret store to be
    usable (consent granted, or ``SOD_ENC_KEY`` set for headless use).

    Raises ``ValueError`` for ``FLOWPAD``: there is nothing to store, the hub
    login is the key and the hub owns the endpoint binding.
    """
    provider = LMApiProvider(provider)
    if provider is LMApiProvider.FLOWPAD:
        raise ValueError("flowpad is bound by the hub login; there is no key to store")
    write_secret(_sod_name(provider), key)


def get_lm_api(provider: LMApiProvider | str) -> str | None:
    """Read the stored key for *provider*, or ``None`` if unset. In-process only —
    never exposed over HTTP. This is what a worker calls when it needs the key.

    For ``FLOWPAD`` this is the hub login key, present only while the hub has
    bound this instance to an ``LLMEndpoint`` AND the box is logged in."""
    provider = LMApiProvider(provider)
    if provider is LMApiProvider.FLOWPAD:
        return _hub_key_if_bound()
    return read_secret(_sod_name(provider))


def list_lm_api() -> list[dict]:
    """List which providers have a key configured. Never returns a value.

    Returns ``[{provider, configured, created_at}]`` for each stored LM key,
    plus -- only when the hub has bound an endpoint -- a ``managed: True`` row for
    ``flowpad`` whose ``configured`` is "bound AND logged in" and whose ``detail``
    is the endpoint typeid. A desktop install without a binding lists nothing new.
    """
    from flow_sdk.instance_settings.llm_endpoint import get_hub_llm_endpoint  # noqa: PLC0415

    out: list[dict] = []
    for record in get_secrets():
        name = record.get("name") or ""
        if not name.startswith(_PREFIX):
            continue
        out.append(
            {
                "provider": name[len(_PREFIX) :],
                "configured": True,
                "created_at": record.get("created_at"),
            }
        )
    bound = get_hub_llm_endpoint()
    if bound is not None:
        from flow_sdk.cli.auth.hub_login import resolve_hub_api_key  # noqa: PLC0415

        out.append(
            {
                "provider": LMApiProvider.FLOWPAD.value,
                "configured": bool(resolve_hub_api_key()),
                "created_at": None,
                "managed": True,
                "detail": bound.endpoint_typeid,
            }
        )
    return out


async def delete_lm_api(provider: LMApiProvider | str) -> None:
    """Remove the stored key for *provider*. Idempotent. A no-op for ``FLOWPAD``:
    the hub owns that binding (``llm-endpoint`` box action, DELETE)."""
    provider = LMApiProvider(provider)
    if provider is LMApiProvider.FLOWPAD:
        return
    await delete_secret(_sod_name(provider))


# Cheap "is this key accepted" probes: a single authenticated GET that returns
# 200 for a valid key and 401 for a bad one — no completion, no token spend. Each
# entry is (url, build_headers(key)) for that provider's account API.
_VALIDATE_ENDPOINTS: dict[str, tuple[str, Callable[[str], dict[str, str]]]] = {
    LMApiProvider.OPENROUTER.value: ("https://openrouter.ai/api/v1/key", _bearer),
    LMApiProvider.ANTHROPIC.value: (
        "https://api.anthropic.com/v1/models",
        lambda key: {"x-api-key": key, "anthropic-version": "2023-06-01"},
    ),
    LMApiProvider.OPENAI.value: ("https://api.openai.com/v1/models", _bearer),
}


def _validate_endpoint(provider: LMApiProvider) -> tuple[str, Callable[[str], dict[str, str]]] | None:
    """(url, build_headers) for the key probe, or ``None`` when the provider has
    no probe target right now (FLOWPAD while unbound). Never raises."""
    if provider is LMApiProvider.FLOWPAD:
        return _flowpad_probe()
    return _VALIDATE_ENDPOINTS.get(provider.value)


async def validate_lm_api(provider: LMApiProvider | str, key: str | None = None) -> dict:
    """Check a key for *provider* against the provider (a real network call).
    Returns ``{"valid": bool, "message": str}`` — never raises. Pass *key* to
    validate an in-hand value (e.g. right after ``set_lm_api`` on the save path),
    skipping a redundant store read/decrypt; otherwise the stored key is loaded."""
    provider = LMApiProvider(provider)
    if key is None:
        key = get_lm_api(provider)
    if not key:
        return {"valid": False, "message": "No key configured"}

    endpoint = _validate_endpoint(provider)
    if endpoint is None:
        return {"valid": False, "message": "No hub LLM endpoint bound"}
    url, build_headers = endpoint
    headers = build_headers(key)
    try:
        import httpx  # noqa: PLC0415

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
    except Exception as exc:  # noqa: BLE001 — surface the reason, don't crash the action
        return {"valid": False, "message": f"Could not reach {provider.value}: {exc}"}

    if resp.status_code == 200:
        return {"valid": True, "message": "Key is valid"}
    if resp.status_code in (401, 403):
        return {"valid": False, "message": f"{provider.value} rejected the key ({resp.status_code})"}
    return {"valid": False, "message": f"{provider.value} returned {resp.status_code}"}


# Model-catalog endpoints (for the mapping picker). OpenRouter's is public; the
# vendor-direct ones need the stored key. Each returns a provider's model list.
_MODELS_ENDPOINTS: dict[str, tuple[str, bool]] = {
    # (url, needs_key)
    LMApiProvider.OPENROUTER.value: ("https://openrouter.ai/api/v1/models", False),
    LMApiProvider.ANTHROPIC.value: ("https://api.anthropic.com/v1/models", True),
    LMApiProvider.OPENAI.value: ("https://api.openai.com/v1/models", True),
}


def _models_endpoint(provider: LMApiProvider) -> tuple[str, bool] | None:
    """(url, needs_key) for the model catalog, or ``None`` when there is no
    catalog to ask (FLOWPAD while unbound). Never raises."""
    if provider is LMApiProvider.FLOWPAD:
        probe = _flowpad_probe()
        return (probe[0], True) if probe else None
    return _MODELS_ENDPOINTS.get(provider.value)


async def list_provider_models(provider: LMApiProvider | str) -> list[dict]:
    """List a provider's available models as ``[{"id": slug, "name": str}]`` for
    the mapping picker. Never raises — returns ``[]`` on any failure (e.g. a
    vendor-direct provider with no stored key)."""
    provider = LMApiProvider(provider)
    endpoint = _models_endpoint(provider)
    if endpoint is None:
        return []
    url, needs_key = endpoint
    headers: dict[str, str] = {}
    if needs_key:
        key = get_lm_api(provider)
        if not key:
            return []
        # Reuse the same auth-header shape the validation probe uses.
        probe = _validate_endpoint(provider)
        if probe is None:
            return []
        headers = probe[1](key)
    try:
        import httpx  # noqa: PLC0415

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
        resp.raise_for_status()
        data = resp.json().get("data") or []
    except Exception:  # noqa: BLE001 — catalog is best-effort; empty on failure
        return []
    out: list[dict] = []
    for m in data:
        mid = m.get("id")
        if mid:
            out.append({"id": mid, "name": m.get("name") or mid})
    return out
