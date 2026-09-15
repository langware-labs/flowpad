"""The one credential resolver: a manifest's ``auth`` and a ``DataSource`` row → ``Credentials``.

A source never reads the environment, the secret store or the connection store itself; it declares
in its manifest which of three shapes it reads with, and the application resolves that shape here:

* ``connector`` — this machine's connection to an OAuth provider, its APP token first when the
  provider issues one (Slack's bot). The app is who a message source should be: it posts as whoever
  the token is, and an inbound message from the human reads as a stranger's — the thing that makes a
  reply addressable — only when we are NOT that human. The user token is the fallback, so an instance
  connected before the app half existed keeps working, degraded rather than broken.
* ``env`` — variables the operator keeps in the environment, each keyed by its own name.
* ``secrets`` — ``{value key: machine secret name}``. A named machine secret (the SOD store, no
  project) wins; the row's own ``config[value key]`` is read otherwise, until per-row secrets move
  out of config. Either way the value reaches the source as a credential, never as configuration.
"""
from __future__ import annotations

import os
from typing import Any, Optional

from pydantic import SecretStr

from flow_sdk.schema.data_spec.data_source_manifest_spec import AuthSpec
from flow_sdk.sources.credentials import AuthShape, Credentials


async def resolve_credentials(auth: Optional[AuthSpec], row: Any) -> Credentials:
    if auth is None:
        return Credentials()
    if auth.connector:
        return await _connector(auth.connector)
    if auth.env:
        values = {name: SecretStr(value) for name in auth.env if (value := str(os.environ.get(name) or "").strip())}
        return Credentials(shape=AuthShape.ENV, values=values) if values else Credentials()
    config = getattr(row, "config", None) or {}
    values = {}
    for key, stored in auth.secrets.items():
        value = _machine_secret(stored) if stored else ""
        if value := value or str(config.get(key) or "").strip():
            values[key] = SecretStr(value)
    return Credentials(shape=AuthShape.SECRETS, values=values) if values else Credentials()


async def _connector(provider: str) -> Credentials:
    from flow_sdk.core.oauth.provider_registry import app_credentials_name, token_for  # noqa: PLC0415

    app = app_credentials_name(provider)
    token = (await token_for(provider, name=app) if app else None) or await token_for(provider)
    return Credentials(shape=AuthShape.CONNECTOR, token=SecretStr(token)) if token else Credentials()


def _machine_secret(name: str) -> str:
    try:
        from flow_sdk.cli.auth.secrets import read_secret  # noqa: PLC0415

        return str(read_secret(name) or "").strip()
    except Exception:  # noqa: BLE001 — a locked or absent store is "no key", not a crash
        return ""


__all__ = ["resolve_credentials"]
