"""The one credential resolver: a manifest's ``auth`` and a ``DataSource`` row → ``ResolvedSecrets``.

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
  default) store; otherwise the named machine secret. A config is value-free: never read here.
* ``credential`` + ``vars`` — ``{value key: env var}`` of a named Credential, resolved for the
  row's owner the way a worker process resolves its secrets (the owning agent's project over the
  user scope), where the deployment that answers the row keeps them.
"""
from __future__ import annotations

import logging
import os
from typing import Any, Optional

from pydantic import SecretStr

from flow_sdk.schema.data_spec.data_driver_spec import AuthSpec
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets

logger = logging.getLogger(__name__)


async def resolve_credentials(auth: Optional[AuthSpec], row: Any) -> ResolvedSecrets:
    if auth is None:
        return ResolvedSecrets()
    if auth.connector:
        return await _connector(str(getattr(row, "connection", "") or "") or auth.connector)
    if auth.credential:
        return await _declared(auth, row)
    stored = await _stored_values(row, list(auth.env) if auth.env else list(auth.secrets))
    if auth.env:
        values = {
            name: SecretStr(value)
            for name in auth.env
            if (value := stored.get(name) or str(os.environ.get(name) or "").strip())
        }
        return ResolvedSecrets(shape=AuthShape.ENV, values=values) if values else ResolvedSecrets()
    values = {}
    for key, secret_name in auth.secrets.items():
        if value := stored.get(key) or (_machine_secret(secret_name) if secret_name else ""):
            values[key] = SecretStr(value)
    return ResolvedSecrets(shape=AuthShape.SECRETS, values=values) if values else ResolvedSecrets()


async def _declared(auth: AuthSpec, row: Any) -> ResolvedSecrets:
    from flow_sdk.builtin.credential_resolver import (  # noqa: PLC0415
        credentials_in_scope,
        declare,
        placement_for_source,
        resolve_project_secrets,
    )

    project = await owner_project(row)
    # Only the named credential's specs: another spec declaring the same variable must not win it.
    pairs = [(spec, scope) for spec, scope in await credentials_in_scope(project) if spec.name == auth.credential]
    # A store the row is bound to answers first (``DataSource.set_secret_store``): what is bound is what it uses.
    wanted = list(auth.vars.values())
    bound = await _stored_values(row, wanted) if getattr(row, "secret_store", None) else {}
    rest = [var for var in wanted if var not in bound]
    loaded = await resolve_project_secrets(
        project, only=rest, declared=declare(pairs), placement=await placement_for_source(row)
    ) if pairs and rest else {}
    values = {}
    for key, var in auth.vars.items():
        if value := bound.get(var) or (loaded[var].get_secret_value().strip() if var in loaded else ""):
            values[key] = SecretStr(value)
    spec = next((spec for spec, scope in pairs if scope.project_id), pairs[0][0]) if pairs else None
    choice, token = await _way(spec, set(wanted) & (set(loaded) | set(bound))) if spec is not None else ("", None)
    if not values and token is None:
        return ResolvedSecrets()
    return ResolvedSecrets(shape=AuthShape.SECRETS, values=values, token=token, choice=choice)


async def _way(spec: Any, held: set[str]) -> tuple[str, Optional[SecretStr]]:
    """Which way of ``spec``'s ONE_OF group the source is handed (``way_order``: the chosen one, else the first
    there), and the grant's token when that way is a sign-in — resolved through the connection exactly as a
    ``connector`` source's is. ``""`` when none is there."""
    from flow_sdk.schema.data_spec.credential_status_spec import way_order  # noqa: PLC0415

    ways = spec.vars or {}
    chosen = spec.chosen
    for name in way_order(ways, chosen):
        var = ways[name]
        if var.is_oauth:
            if (token := (await _connector(var.provider)).token) is not None:
                return name, token
        elif name == chosen or name in held:
            return name, None
    return chosen, None


async def owner_project(row: Any) -> Any:
    """The owning agent's project, else the row's own; None (the user scope alone) for a row with neither, or for an agent
    shipped in a system project: that project is the SDK's own read-only content (its credential
    folders ARE the shipped templates), so a setup step declaring there collided with the template
    ("a credential named 'whatsapp' already exists") and nothing it learned could be kept."""
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.stream_inbox.projection import owning_agent  # noqa: PLC0415

    # No owning agent (a source a person added): the project the row was created in — where its setup stores values.
    project_id = str(getattr(await owning_agent(row), "project_id", "") or getattr(row, "project_id", "") or "")
    project = await Project.get_by_id(project_id) if project_id else None
    return None if project is not None and getattr(project, "system", False) else project


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


async def _connector(provider: str) -> ResolvedSecrets:
    from flow_sdk.core.oauth.provider_registry import app_credentials_name, token_for  # noqa: PLC0415

    app = app_credentials_name(provider)
    token = (await token_for(provider, name=app) if app else None) or await token_for(provider)
    return ResolvedSecrets(shape=AuthShape.CONNECTOR, token=SecretStr(token)) if token else ResolvedSecrets()


def _machine_secret(name: str) -> str:
    try:
        from flow_sdk.cli.auth.secrets import read_secret  # noqa: PLC0415

        return str(read_secret(name) or "").strip()
    except Exception:  # noqa: BLE001 — a locked or absent store is "no key", not a crash
        return ""


__all__ = ["resolve_credentials"]
