"""An agent's Env, on this computer: ``agent.json`` → ``env``, and its sync with the hub.

The file holds the entries — names, kind, the owner's approval (``inject``) and plain values. The hub holds
what only it can: each secret's value (write-only, ``agent/<id>/env-var``), whether it is ``written``, where
each entry was placed, and the variables Flowpad itself provides (``system``). ``PUT agent/<id>/env`` sends
the entries (plain values included, secrets as names only); ``GET agent/<id>/env`` reads the hub's view.

An agent that is not on the hub (unpublished, offline, signed out) is answered from the file alone:
nothing written, nothing placed, no system rows.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Iterable, Optional

from flow_sdk.schema.data_spec.agent_env_spec import ENV_KIND_PLAIN, AgentEnvEntry, unique_entries

if TYPE_CHECKING:
    from flow_sdk.builtin.agent import Agent

logger = logging.getLogger(__name__)


def parse_entries(raw: Optional[Iterable[Any]]) -> list[AgentEnvEntry]:
    """Entries (``agent.env`` or a request body), each name once; a secret's value, if one was sent, is dropped."""
    return unique_entries([AgentEnvEntry.model_validate(e) for e in raw or []])


def hub_payload(entries: list[AgentEnvEntry]) -> dict:
    """The ``PUT agent/<id>/env`` body: plain values ride along, secrets are names only."""
    return {"entries": [e.hub_entry() for e in entries]}


def local_view(entries: list[AgentEnvEntry]) -> dict:
    """The ``agent/<id>/env`` shape answered from the file alone (the agent is not on the hub)."""
    rows = []
    for e in entries:
        row = {"name": e.name, "kind": e.kind, "description": e.description, "inject": e.inject, "written": False}
        if e.kind == ENV_KIND_PLAIN:
            row["value"] = e.value
            row["written"] = e.value is not None and e.value != ""
        rows.append(row)
    return {"entries": rows, "system": [], "placements": []}


def _on_hub(agent: "Agent") -> bool:
    return bool(getattr(agent, "remote", False))


def merge_view(entries: list[AgentEnvEntry], hub: Optional[dict]) -> dict:
    """The hub's view as it answered it (entries with ``inject``/``written``, ``system``, ``placements``);
    the file's entries alone when there is no hub answer (offline, unpublished)."""
    if not isinstance(hub, dict):
        return local_view(entries)
    return {
        "entries": [r for r in hub.get("entries") or [] if isinstance(r, dict)],
        "system": list(hub.get("system") or []),
        "placements": list(hub.get("placements") or []),
    }


async def read_env(agent: "Agent") -> dict:
    """``agent/<id>/env`` as this computer answers it: the hub's view when the agent is there."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    hub = await HubProxy.try_call("GET", agent.get_type(), str(agent.id), action="env") if _on_hub(agent) else None
    return merge_view(parse_entries(agent.env), hub)


def _env_sync_key(agent: "Agent") -> Optional[tuple[str, str]]:
    """(hub repo id, the agent's path in it): where this desk remembers its last Env sync."""
    from flow_sdk.builtin.agent_places import hub_origin  # noqa: PLC0415

    origin = hub_origin(agent)
    return (origin.repo_id, origin.rel_path) if origin is not None else None


def _digest(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


async def sync_env_to_hub(
    agent: "Agent", *, call: Optional[Callable[..., Awaitable[Any]]] = None, if_changed: bool = False
) -> Optional[dict]:
    """Send the file's entries to the hub (``PUT agent/<id>/env``); the hub's answer, or ``None`` when the
    agent is not there. ``call`` is ``HubProxy.try_call`` (the default: ``None`` when the hub could not be
    reached) or ``HubProxy.call`` (raise ``HubError``). ``if_changed``: skip the PUT when the payload is the
    one this desk last synced."""
    from flow_sdk.assets.hub_repo_sync import last_env_sync, remember_env_sync  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    if not _on_hub(agent):
        return None
    payload = hub_payload(parse_entries(agent.env))
    digest, key = _digest(payload), _env_sync_key(agent)
    if if_changed and key is not None and last_env_sync(*key) == digest:
        return None
    answer = await (call or HubProxy.try_call)("PUT", agent.get_type(), str(agent.id), "env", payload=payload)
    if answer is not None and key is not None:
        remember_env_sync(*key, digest)
    return answer


async def save_env(agent: "Agent", raw: Iterable[Any]) -> dict:
    """Write ``raw`` as the agent's Env into ``agent.json`` and sync it to the hub; the resulting view."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    entries = parse_entries(raw)
    agent.env = entries or None
    await agent.save()
    return merge_view(entries, await sync_env_to_hub(agent, call=HubProxy.call))


async def _put_secret(agent: "Agent", name: str, value: str) -> None:
    """One secret value into the agent's hub store (``POST agent/<id>/env-var``), write-only."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    payload = {"name": name, "value": value, "var_type": "api_key"}
    await HubProxy.call("POST", agent.get_type(), str(agent.id), "env-var", payload=payload)


async def use_mine(agent: "Agent", names: list[str]) -> dict:
    """Copy this computer's values for ``names`` (secret entries of the agent's Env) into the agent's hub
    store. A value is read and sent here, never shown or logged: ``{copied, not_here, hub_funded}`` names.
    An LLM provider key is never copied: a deployment is hub-funded."""
    from flow_sdk.builtin.credential_resolver import declared_vars, resolve_project_secrets  # noqa: PLC0415
    from flow_sdk.builtin.credential_store import Placement  # noqa: PLC0415
    from flow_sdk.builtin.readiness import project_of  # noqa: PLC0415

    if not _on_hub(agent):
        raise ValueError("publish the agent first: its secret values are held by the hub")
    secrets = {e.name for e in parse_entries(agent.env) if e.kind != ENV_KIND_PLAIN}
    names = [n for n in dict.fromkeys(names) if n in secrets]
    project = await project_of(agent)
    declared = await declared_vars(project)
    funded = sorted(n for n in names if n in declared and declared[n].spec.lm_provider)
    names = [n for n in names if n not in funded]
    mine = await resolve_project_secrets(project, only=names, declared=declared, placement=await Placement.of(None))
    await asyncio.gather(*(_put_secret(agent, name, value.get_secret_value()) for name, value in mine.items()))
    return {"copied": sorted(mine), "not_here": sorted(set(names) - set(mine)), "hub_funded": funded}


__all__ = [
    "hub_payload",
    "local_view",
    "merge_view",
    "parse_entries",
    "read_env",
    "save_env",
    "sync_env_to_hub",
    "use_mine",
]
