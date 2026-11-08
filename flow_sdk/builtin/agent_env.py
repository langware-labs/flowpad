"""An agent's Env, on this computer: ``agent.json`` → ``env``, and its sync with the hub.

The file holds the entries — names, kind, the owner's approval (``inject``) and plain values. The hub holds
what only it can: each secret's value (write-only, ``agent/<id>/env-var``), whether it is ``written``, where
each entry was placed, and the variables Flowpad itself provides (``system``). ``PUT agent/<id>/env`` sends
the entries (plain values included, secrets as names only); ``GET agent/<id>/env`` reads the hub's view.

An agent that is not on the hub (unpublished, offline, signed out) is answered from the file alone:
nothing written, nothing placed, no system rows.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any, Iterable, Optional

from flow_sdk.schema.data_spec.agent_env_spec import ENV_KIND_PLAIN, AgentEnvEntry, unique_entries

if TYPE_CHECKING:
    from flow_sdk.builtin.agent import Agent

logger = logging.getLogger(__name__)


def entries_of(agent: "Agent") -> list[AgentEnvEntry]:
    """The agent's Env entries, each name once."""
    return unique_entries([AgentEnvEntry.model_validate(e) for e in (agent.env or [])])


def parse_entries(raw: Iterable[Any]) -> list[AgentEnvEntry]:
    """Entries from a request body; a secret's value, if one was sent, is dropped."""
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
    """The hub's view, with the file's entries as the list (the file is the author's): an entry the hub
    does not know yet shows as not written; plain values come from the file."""
    if not isinstance(hub, dict):
        return local_view(entries)
    by_name = {str(r.get("name")): r for r in hub.get("entries") or [] if isinstance(r, dict)}
    local = local_view(entries)["entries"]
    rows = []
    for row in local:
        held = by_name.get(row["name"]) or {}
        merged = {**row, "written": bool(held.get("written", row["written"]))}
        rows.append(merged)
    return {"entries": rows, "system": list(hub.get("system") or []), "placements": list(hub.get("placements") or [])}


async def read_env(agent: "Agent") -> dict:
    """``agent/<id>/env`` as this computer answers it: the hub's view when the agent is there."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    entries = entries_of(agent)
    if not _on_hub(agent):
        return local_view(entries)
    return merge_view(entries, await HubProxy.try_call("GET", agent.get_type(), str(agent.id), action="env"))


async def sync_env_to_hub(agent: "Agent", *, strict: bool = False) -> Optional[dict]:
    """Send the file's entries to the hub (``PUT agent/<id>/env``); the hub's answer, or ``None`` when the
    agent is not there or the hub could not be reached (``strict``: raise ``HubError`` instead)."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    if not _on_hub(agent):
        return None
    payload = hub_payload(entries_of(agent))
    if strict:
        return await HubProxy.call("PUT", agent.get_type(), str(agent.id), "env", payload=payload)
    return await HubProxy.try_call("PUT", agent.get_type(), str(agent.id), "env", payload=payload)


async def save_env(agent: "Agent", raw: Iterable[Any]) -> dict:
    """Write ``raw`` as the agent's Env into ``agent.json`` and sync it to the hub; the resulting view."""
    entries = parse_entries(raw)
    agent.env = entries or None
    await agent.save()
    hub = await sync_env_to_hub(agent, strict=True)
    return merge_view(entries, hub) if hub is not None else local_view(entries)


async def use_mine(agent: "Agent", names: list[str]) -> dict:
    """Copy this computer's values for ``names`` (secret entries of the agent's Env) into the agent's hub
    store. A value is read and sent here, never shown or logged: ``{copied, not_here, hub_funded}`` names.
    An LLM provider key is never copied: a deployment is hub-funded."""
    from flow_sdk.builtin.credential_resolver import declared_vars, resolve_project_secrets  # noqa: PLC0415
    from flow_sdk.builtin.credential_store import Placement  # noqa: PLC0415
    from flow_sdk.builtin.readiness import project_of  # noqa: PLC0415
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    if not _on_hub(agent):
        raise ValueError("publish the agent first: its secret values are held by the hub")
    secrets = {e.name for e in entries_of(agent) if e.kind != ENV_KIND_PLAIN}
    names = [n for n in dict.fromkeys(names) if n in secrets]
    project = await project_of(agent)
    declared = await declared_vars(project)
    funded = sorted(n for n in names if n in declared and declared[n].spec.lm_provider)
    names = [n for n in names if n not in funded]
    mine = await resolve_project_secrets(project, only=names, declared=declared, placement=await Placement.of(None))
    for name, value in mine.items():
        await HubProxy.call(
            "POST",
            agent.get_type(),
            str(agent.id),
            "env-var",
            payload={"name": name, "value": value.get_secret_value(), "var_type": "api_key"},
        )
    return {"copied": sorted(mine), "not_here": sorted(set(names) - set(mine)), "hub_funded": funded}


__all__ = [
    "entries_of",
    "hub_payload",
    "local_view",
    "merge_view",
    "parse_entries",
    "read_env",
    "save_env",
    "sync_env_to_hub",
    "use_mine",
]
