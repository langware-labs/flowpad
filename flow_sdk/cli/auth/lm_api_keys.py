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
