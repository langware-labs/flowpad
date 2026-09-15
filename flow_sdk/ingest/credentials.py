"""The one credential resolver: a manifest's ``auth`` and a ``DataSource`` row → ``Credentials``.

A source never reads the environment, the secret store or the connection store itself; it declares
in its manifest which of three shapes it reads with, and the application resolves that shape here.
A row may BIND where it reads from (``DataSource.set_secret_store`` / ``set_connection``); what is
bound is what it uses, and the binding is saved on the row so every background path sees it.

* ``connector`` — the bound connection's provider, else the manifest's. Its APP token first when
  the provider issues one (Slack's bot). The app is who a message source should be: it posts as
  whoever the token is, and an inbound message from the human reads as a stranger's — the thing
  that makes a reply addressable — only when we are NOT that human. The user token is the fallback,
  so an instance connected before the app half existed keeps working, degraded rather than broken.
* ``env`` — variable names, loaded from the bound store; unbound, from the default store (the
  current project's ``.env.local``), then the process environment for any still missing.
* ``secrets`` — ``{value key: machine secret name}``, loaded by value key from the bound (or
  default) store; otherwise the named machine secret, then the row's own ``config[value key]``.
  Either way the value reaches the source as a credential, never as configuration.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from pydantic import SecretStr

from flow_sdk.schema.data_spec.data_source_manifest_spec import AuthSpec
from flow_sdk.sources.credentials import AuthShape, Credentials

logger = logging.getLogger(__name__)


async def resolve_credentials(auth: Optional[AuthSpec], row: Any) -> Credentials:
    if auth is None:
        return Credentials()
    if auth.connector:
        return await _connector(str(getattr(row, "connection", "") or "") or auth.connector)
    stored = await _stored_values(row, list(auth.env) if auth.env else list(auth.secrets))
    if auth.env:
        values = {
            name: SecretStr(value)
            for name in auth.env
            if (value := stored.get(name) or str(os.environ.get(name) or "").strip())
        }
        return Credentials(shape=AuthShape.ENV, values=values) if values else Credentials()
    config = getattr(row, "config", None) or {}
    values = {}
    for key, secret_name in auth.secrets.items():
        value = stored.get(key) or (_machine_secret(secret_name) if secret_name else "")
        if value := value or str(config.get(key) or "").strip():
            values[key] = SecretStr(value)
    return Credentials(shape=AuthShape.SECRETS, values=values) if values else Credentials()


async def _stored_values(row: Any, names: list[str]) -> dict[str, str]:
    """``names`` from the row's bound store, else the default store. A store that cannot answer
    (no current project, an unreadable file) holds nothing; only its type is logged."""
    from flow_sdk.secrets import NoCurrentProject, SecretStore, load_all  # noqa: PLC0415

    if not names:
        return {}
    ref = getattr(row, "secret_store", None)
    try:
        store = SecretStore.from_ref(ref) if ref else await SecretStore.get()
    except NoCurrentProject:
        return {}
    (loaded,) = await load_all([(store, names)])  # a store that fails holds nothing
    return {name: text for name, value in loaded.items() if (text := value.get_secret_value().strip())}


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
