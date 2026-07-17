"""LLM-provider API keys — provider-aware wrappers over the app-secret store.

Each provider key is written to the per-instance encrypted ``sod`` store (via
``secrets.py``) under a namespaced name ``lm_api.<provider>``, keeping LM keys an
enumerable set addressable by provider. In-process callers (a worker at spawn)
read them via :func:`get_lm_api`; :func:`list_lm_api` never returns a value.

The ``lm_api.`` prefix is a naming convention over the shared flat secret
keyspace, not an enforced reservation — a user secret named ``lm_api.*`` shares
the namespace.
"""

from __future__ import annotations

from typing import Callable

from flow_sdk.cli.auth.secrets import delete_secret, get_secrets, read_secret, write_secret
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider

_PREFIX = "lm_api."


def _sod_name(provider: LMApiProvider | str) -> str:
    return f"{_PREFIX}{LMApiProvider(provider).value}"


def set_lm_api(key: str, provider: LMApiProvider | str) -> None:
    """Store *key* for *provider* in the standard secret store (in-process).

    Overwrites any existing key for the provider. Requires the secret store to be
    usable (consent granted, or ``SOD_ENC_KEY`` set for headless use).
    """
    write_secret(_sod_name(provider), key)


def get_lm_api(provider: LMApiProvider | str) -> str | None:
    """Read the stored key for *provider*, or ``None`` if unset. In-process only —
    never exposed over HTTP. This is what a worker calls when it needs the key."""
    return read_secret(_sod_name(provider))


def list_lm_api() -> list[dict]:
    """List which providers have a key configured. Never returns a value.

    Returns ``[{provider, configured, created_at}]`` for each stored LM key.
    """
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
    return out


async def delete_lm_api(provider: LMApiProvider | str) -> None:
    """Remove the stored key for *provider*. Idempotent."""
    await delete_secret(_sod_name(provider))


# Cheap "is this key accepted" probes: a single authenticated GET that returns
# 200 for a valid key and 401 for a bad one — no completion, no token spend. Each
# entry is (url, build_headers(key)) for that provider's account API.
_VALIDATE_ENDPOINTS: dict[str, tuple[str, Callable[[str], dict[str, str]]]] = {
    LMApiProvider.OPENROUTER.value: (
        "https://openrouter.ai/api/v1/key",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
    LMApiProvider.ANTHROPIC.value: (
        "https://api.anthropic.com/v1/models",
        lambda key: {"x-api-key": key, "anthropic-version": "2023-06-01"},
    ),
    LMApiProvider.OPENAI.value: (
        "https://api.openai.com/v1/models",
        lambda key: {"Authorization": f"Bearer {key}"},
    ),
}


async def validate_lm_api(provider: LMApiProvider | str) -> dict:
    """Check the stored key for *provider* against the provider (a real network
    call). Returns ``{"valid": bool, "message": str}`` — never raises."""
    provider = LMApiProvider(provider)
    key = get_lm_api(provider)
    if not key:
        return {"valid": False, "message": "No key configured"}

    url, build_headers = _VALIDATE_ENDPOINTS[provider.value]
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
