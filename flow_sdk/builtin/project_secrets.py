"""The project's secret store on the hub (``project/<id>/env-var``): write-only, read back as names only.

The owner and project admins set values there; every deployment of the project's agents gets the ones its
agent requires (the hub's ``place_secrets``). This computer only ever WRITES a value — "Use mine" copies its
own values in — and asks which names are set.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from flow_sdk.schema.data_spec.spec import DataSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.project import Project


class SecretsUseMineRequest(DataSpec):
    """`POST project/<id>/secrets_use_mine {names}` — the variables to copy (none: nothing)."""

    names: list[str] = []


async def set_names(project: "Project") -> set[str]:
    """The variable names the project's hub store holds a value for. Never a value."""
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    rows = await HubProxy.try_call("GET", "project", str(project.id), "env-var")
    rows = rows.get("values") if isinstance(rows, dict) else rows
    return {str(r.get("name")) for r in rows or [] if isinstance(r, dict) and r.get("name")}


async def _put(project: "Project", name: str, value: str, exists: bool) -> None:
    # A set name is changed (PUT env-var/<NAME>); a new one created (POST) — the hub refuses a second create.
    from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415

    if exists:
        payload = {"value": value, "var_type": "api_key"}
        await HubProxy.call("PUT", "project", str(project.id), f"env-var/{name}", payload=payload)
    else:
        payload = {"name": name, "value": value, "var_type": "api_key"}
        await HubProxy.call("POST", "project", str(project.id), "env-var", payload=payload)


async def use_mine(project: "Project", names: list[str]) -> dict:
    """Copy this computer's values for ``names`` into the project's hub store. A value is read and sent, never
    shown or logged: ``{copied, not_here, hub_funded}`` are names. An LLM provider key is never copied — a
    deployment's model turns are hub-funded."""
    from flow_sdk.builtin.credential_resolver import declared_vars, resolve_project_secrets  # noqa: PLC0415
    from flow_sdk.builtin.credential_store import Placement  # noqa: PLC0415

    names = list(dict.fromkeys(n for n in names if n))
    declared = await declared_vars(project)
    funded = sorted(n for n in names if n in declared and declared[n].spec.lm_provider)
    names = [n for n in names if n not in funded]
    mine = await resolve_project_secrets(project, only=names, declared=declared, placement=await Placement.of(None))
    held = await set_names(project)
    await asyncio.gather(*(_put(project, n, v.get_secret_value(), n in held) for n, v in mine.items()))
    return {"copied": sorted(mine), "not_here": sorted(set(names) - set(mine)), "hub_funded": funded}


__all__ = ["SecretsUseMineRequest", "set_names", "use_mine"]
