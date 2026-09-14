"""Which credentials apply to a process, and their values.

The one resolver behind every consumer — worker spawn, terminals, and the
compute-node connector. A process in project P sees the variables declared by
user-scope credentials and by P's project-scope credentials; a project
declaration overrides a user one of the same name. Templates (the shipped
catalogue) never apply. Only declared variables are ever injected: a key sitting
in ``.env.local`` that no credential names stays out of the process.

Node attachment (``ComputeNode.attached_secrets``) filters the result: ``None``
means nothing was curated, i.e. every declared variable.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Iterable, Optional

from pydantic import SecretStr

from flow_sdk.builtin.credential_store import (
    CredentialScope,
    project_scope,
    read_values,
    spec_scope_name,
    user_scope,
)
from flow_sdk.schema.data_spec.credential_contract import SCOPE_PROJECT, SCOPE_USER

if TYPE_CHECKING:
    from flow_sdk.builtin.credential_spec import CredentialSpec
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

CredentialPairs = list[tuple["CredentialSpec", CredentialScope]]


@dataclass(frozen=True)
class DeclaredVar:
    env_var: str
    spec: "CredentialSpec"
    scope: CredentialScope


async def credentials_in_scope(project: Optional["Project"]) -> CredentialPairs:
    """The credentials a process in ``project`` sees: user first, then project."""
    from flow_sdk.builtin.credential_spec import CredentialSpec  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    user = user_scope()
    proj = project_scope(project) if project is not None else None
    wanted = [ExpressionNode(op=QueryOp.EQ, operands=["scope", SCOPE_USER])]
    if proj is not None:
        wanted.append(ExpressionNode(op=QueryOp.EQ, operands=["project_id", proj.project_id]))
    match = wanted[0] if len(wanted) == 1 else ExpressionNode(op=QueryOp.OR, operands=wanted)

    users: CredentialPairs = []
    projects: CredentialPairs = []
    for spec in await CredentialSpec.get_all(QueryFilter(match=match)):
        name = spec_scope_name(spec)
        if name == SCOPE_USER:
            users.append((spec, user))
        elif name == SCOPE_PROJECT and proj is not None and str(spec.project_id or "") == proj.project_id:
            projects.append((spec, proj))
    return users + projects


def declare(pairs: CredentialPairs) -> dict[str, DeclaredVar]:
    """Fold credentials into one declaration per variable, project overriding user."""
    out: dict[str, DeclaredVar] = {}
    for spec, scope in pairs:
        for env_var in spec.var_names():
            previous = out.get(env_var)
            if previous is not None and previous.scope.scope == scope.scope:
                # Two specs in one scope must not declare the same variable;
                # saving refuses it. A hand-authored pair keeps the first.
                logger.warning(
                    "[credentials] %s is declared twice in %s scope (%s, %s); using %s",
                    env_var, scope.scope, previous.spec.name, spec.name, previous.spec.name,
                )
                continue
            out[env_var] = DeclaredVar(env_var=env_var, spec=spec, scope=scope)
    return out


async def declared_vars(project: Optional["Project"]) -> dict[str, DeclaredVar]:
    """Every declared variable for ``project``, project overriding user."""
    return declare(await credentials_in_scope(project))


async def resolve_project_secrets(
    project: Optional["Project"],
    *,
    only: Optional[Iterable[str]] = None,
    declared: Optional[dict[str, DeclaredVar]] = None,
) -> dict[str, SecretStr]:
    """Resolve every declared variable that ``only`` permits.

    A store that fails is skipped (see ``read_values``) — a missing value must
    never take down a spawn, and a value must never reach a log line.
    """
    if declared is None:
        declared = await declared_vars(project)
    allowed = None if only is None else set(only)
    targets = [(d.spec, d.scope, d.env_var) for d in declared.values() if allowed is None or d.env_var in allowed]
    if not targets:
        return {}
    try:
        values = await read_values(targets)
    except Exception as e:  # noqa: BLE001
        logger.debug("[credentials] could not resolve values: %s", type(e).__name__)
        return {}
    return {env_var: SecretStr(value) for env_var, value in values.items()}


async def attached_env_vars_for(project: Optional["Project"]) -> Optional[list[str]]:
    """The node filter for ``project``, or ``None`` when nothing is recorded."""
    if project is None:
        return None
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415

    try:
        node = await ComputeNode.get_local(create=False)
    except Exception:  # noqa: BLE001
        return None
    if node is None:
        return None
    return node.attached_env_vars(str(project.id))


async def resolve_attached_secrets(project: Optional["Project"]) -> dict[str, SecretStr]:
    """The declared values the local node lets ``project``'s processes see.

    The one entry point for spawns (worker, terminal, node command). Nothing
    declared — the common case — returns before the node lookup.
    """
    declared = await declared_vars(project)
    if not declared:
        return {}
    return await resolve_project_secrets(project, only=await attached_env_vars_for(project), declared=declared)
