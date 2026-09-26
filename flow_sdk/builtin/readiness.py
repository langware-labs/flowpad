"""An agent's requirements, and whether a deployment satisfies them — names only, never a value.

**Requirements** are derived from what the agent owns — each data source's ``auth`` and its driver's
``permissions``, each MCP server's ``${VAR}`` references — and merged with entries a person authored
(``AgentSpec.requirements``); :func:`refresh_requirements` writes them into ``agent.json`` so they ship.

**Readiness** answers per requirement at one deployment (``credential_store.Placement``):

* a credential or variable — its values are present in the store that deployment keeps them in →
  ``declared`` (a key is present; what it allows cannot be checked); else ``missing``;
* an OAuth permission or connection — the connection is held and grants the mapped scopes → ``verified``;
* an API-key permission — the variable that grants it is present → ``declared``.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.schema.data_spec.permission_spec import (
    MECHANISM_API_KEY,
    MECHANISM_OAUTH,
    STATUS_DECLARED,
    STATUS_MISSING,
    STATUS_VERIFIED,
    provider_of,
)
from flow_sdk.schema.data_spec.requirement_spec import (
    REQUIREMENT_CONNECTION,
    REQUIREMENT_CREDENTIAL,
    REQUIREMENT_PERMISSION,
    REQUIREMENT_VARIABLE,
    ReadinessItemSpec,
    ReadinessSpec,
    RequirementSpec,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.builtin.deployment import Deployment

#: ``${NAME}`` / ``$NAME`` — an MCP server env value that reads a variable instead of carrying one.
_VAR_REF = re.compile(r"^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$")


# ── requirements ──────────────────────────────────────────────────────────────


async def _credential_for(names: dict[str, str], project: Any) -> dict[str, str]:
    """``{VAR: credential name}`` for the variables a declared credential (else a shipped template)
    declares — the project's own over the user's, as a process would resolve them."""
    from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415
    from flow_sdk.builtin.credential_service import shipped_templates  # noqa: PLC0415

    owner: dict[str, str] = {}
    for spec, _ in [*[(t, None) for t in await shipped_templates()], *await credentials_in_scope(project)]:
        for var in spec.var_names():
            if var in names:
                owner[var] = str(spec.name)
    return owner


async def requirements_of_source(source: "DataSource", project: Any = None) -> list[RequirementSpec]:
    """What one data source needs, from its driver: permissions, a credential, variables."""
    from flow_sdk import permissions  # noqa: PLC0415
    from flow_sdk.builtin.project_setup import _auth_of  # noqa: PLC0415

    auth = await _auth_of(source)
    if auth is None:
        return []
    used_by = [str(source.name or source.id)]
    out = [
        RequirementSpec(kind=REQUIREMENT_PERMISSION, name=need.permission, why=need.why, derived=True, used_by=used_by)
        for need in permissions.needs_of_driver(source.provider or "")
    ]
    if auth.connector and not any(r.kind == REQUIREMENT_PERMISSION for r in out):
        out.append(RequirementSpec(kind=REQUIREMENT_CONNECTION, name=auth.connector, scopes=list(auth.scopes),
                                   derived=True, used_by=used_by))
    if auth.credential:
        out.append(RequirementSpec(kind=REQUIREMENT_CREDENTIAL, name=auth.credential, vars=list(auth.vars.values()),
                                   derived=True, used_by=used_by))
    names = list(auth.env) if auth.env else list(auth.secrets)
    if names:
        owner = await _credential_for({n: n for n in names}, project)
        by_credential: dict[str, list[str]] = {}
        for name in names:
            if name in owner:
                by_credential.setdefault(owner[name], []).append(name)
            else:
                out.append(RequirementSpec(kind=REQUIREMENT_VARIABLE, name=name, derived=True, used_by=used_by))
        out += [RequirementSpec(kind=REQUIREMENT_CREDENTIAL, name=cred, vars=vars_, derived=True, used_by=used_by)
                for cred, vars_ in by_credential.items()]
    return out


def merge(requirements: list[RequirementSpec]) -> list[RequirementSpec]:
    """One entry per ``(kind, name, on)``: variables, scopes and users unioned; authored wins over derived."""
    merged: dict[tuple, RequirementSpec] = {}
    for req in requirements:
        first = merged.get(req.key)
        if first is None:
            merged[req.key] = req
            continue
        merged[req.key] = first.model_copy(update={
            "vars": list(dict.fromkeys([*first.vars, *req.vars])),
            "scopes": list(dict.fromkeys([*first.scopes, *req.scopes])),
            "used_by": list(dict.fromkeys([*first.used_by, *req.used_by])),
            "why": first.why or req.why,
            "derived": first.derived and req.derived,
        })
    return list(merged.values())


async def derive_requirements(agent: "Agent") -> list[RequirementSpec]:
    """Everything ``agent`` needs, from what it owns right now."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    project = await Project.get_by_id(str(agent.project_id)) if getattr(agent, "project_id", None) else None
    out: list[RequirementSpec] = []
    for source in await DataSource.find_owned(agent.typeid):
        out += await requirements_of_source(source, project)
    refs: dict[str, str] = {}
    for spec in await agent.resolved_mcp_specs():
        for value in (spec.env or {}).values():
            if match := _VAR_REF.match(str(value).strip()):
                refs.setdefault(match.group(1), f"mcp:{spec.name}")
    owner = await _credential_for(refs, project)
    for var, user in refs.items():
        kind = REQUIREMENT_CREDENTIAL if var in owner else REQUIREMENT_VARIABLE
        out.append(RequirementSpec(kind=kind, name=owner.get(var, var), vars=[var] if var in owner else [],
                                   derived=True, used_by=[user]))
    return merge(out)


async def requirements(agent: "Agent") -> list[RequirementSpec]:
    """The agent's requirements now: its authored entries, then what it owns."""
    authored = [r for r in agent.requirements or [] if not r.derived]
    return merge([*authored, *await derive_requirements(agent)])


async def refresh_requirements(agent: "Agent") -> bool:
    """Write the current requirements into ``agent.json``; ``True`` when they changed."""
    current = await requirements(agent)
    if current == list(agent.requirements or []):
        return False
    agent.requirements = current or None
    await agent.save()
    return True


# ── readiness ─────────────────────────────────────────────────────────────────


async def _connection_item(req: RequirementSpec, connector: str, scopes: list[str]) -> ReadinessItemSpec:
    from flow_sdk.connections import Connection, MissingScopes, NotConnected  # noqa: PLC0415

    where = f"connection {connector}"
    try:
        connection = await Connection.get(connector)
        if scopes:
            await connection.validate_scopes(scopes)
    except NotConnected:
        return ReadinessItemSpec(requirement=req, status=STATUS_MISSING, where=where, fix=f"flow connections connect {connector}")
    except MissingScopes as e:
        return ReadinessItemSpec(requirement=req, status=STATUS_MISSING, where=where,
                                 fix=f"reconnect {connector}, granting {', '.join(e.missing)}")
    return ReadinessItemSpec(requirement=req, status=STATUS_VERIFIED, where=where)


def _values_item(req: RequirementSpec, names: list[str], present: dict[str, tuple[bool, str]], fix: str) -> ReadinessItemSpec:
    missing = [n for n in names if not present.get(n, (False, ""))[0]]
    where = ", ".join(sorted({present[n][1] for n in names if n in present})) or "no store declares it"
    if missing or not names:
        return ReadinessItemSpec(requirement=req, status=STATUS_MISSING, where=where, fix=fix)
    return ReadinessItemSpec(requirement=req, status=STATUS_DECLARED, where=where)


async def readiness(agent: "Agent", deployment: Optional["Deployment"] = None) -> ReadinessSpec:
    """Does ``deployment`` (default: this computer) satisfy ``agent``'s requirements?"""
    from flow_sdk import permissions  # noqa: PLC0415
    from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415
    from flow_sdk.builtin.credential_store import Placement  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    placement = await Placement.of(deployment)
    project = await Project.get_by_id(str(agent.project_id)) if getattr(agent, "project_id", None) else None
    status = await credentials_status(project, placement.deployment_id)
    rows = {row.name: row for row in status.credentials}  # user first, then project: the project's own wins
    present = {v.env_var: (v.present, v.store) for row in status.credentials for v in row.vars}

    items: list[ReadinessItemSpec] = []
    for req in await requirements(agent):
        if req.kind == REQUIREMENT_CREDENTIAL:
            row = rows.get(req.name)
            names = req.vars or ([v.env_var for v in row.vars if v.required] if row else [])
            items.append(_values_item(req, names, present, f"flow credentials set {req.name} --stdin"))
        elif req.kind == REQUIREMENT_VARIABLE:
            items.append(_values_item(req, [req.name], present, f"declare a credential with {req.name}"))
        elif req.kind == REQUIREMENT_CONNECTION:
            items.append(await _connection_item(req, req.name, req.scopes))
        else:
            mapping = permissions.mapping(req.name)
            if mapping is not None and mapping.mechanism == MECHANISM_OAUTH:
                items.append(await _connection_item(req, mapping.connector or provider_of(req.name), mapping.oauth_scopes))
            elif mapping is not None and mapping.mechanism == MECHANISM_API_KEY and mapping.api_key:
                items.append(_values_item(req, [mapping.api_key], present, f"store {mapping.api_key}"))
            else:
                items.append(ReadinessItemSpec(requirement=req, status=STATUS_MISSING,
                                               fix="no grant for this permission here yet" if mapping else "no asset declares this permission"))
    return ReadinessSpec(
        agent_id=str(agent.id), deployment_id=placement.deployment_id, environment=placement.environment,
        ready=all(item.status != STATUS_MISSING for item in items), items=items,
    )


__all__ = ["derive_requirements", "merge", "readiness", "refresh_requirements", "requirements", "requirements_of_source"]
