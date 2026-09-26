"""Which credentials apply to a process, and their values.

The one resolver behind every consumer — worker spawn, terminals, and the
compute-node connector. A process in project P sees the variables declared by
user-scope credentials and by P's project-scope credentials; a project
declaration overrides a user one of the same name. Templates (the shipped
catalogue) never apply. Only declared variables are ever injected: a key sitting
in ``.env.local`` that no credential names stays out of the process.

Node attachment (``ComputeNode.attached_secrets``) filters the result: ``None``
means nothing was curated, i.e. every declared variable.

Values are read at ONE placement (``credential_store.Placement``): the Deployment
the process runs under, else this computer (:func:`placement_for`). Declarations
never differ by deployment — only where the values are read.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Optional

from pydantic import SecretStr

from flow_sdk.builtin.credential_store import (
    CredentialScope,
    Placement,
    project_scope,
    read_values,
    spec_scope_name,
    user_scope,
)
from flow_sdk.schema.data_spec.credential_contract import SCOPE_PROJECT, SCOPE_USER
from flow_sdk.schema.data_spec.deployment_secrets_spec import DeploymentSecretsSpec

if TYPE_CHECKING:
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

CredentialPairs = list[tuple["Credential", CredentialScope]]


@dataclass(frozen=True)
class DeclaredVar:
    env_var: str
    spec: "Credential"
    scope: CredentialScope


async def credentials_in_scope(project: Optional["Project"]) -> CredentialPairs:
    """The credentials a process in ``project`` sees: user first, then project."""
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    user = user_scope()
    proj = project_scope(project) if project is not None else None
    wanted = [ExpressionNode(op=QueryOp.EQ, operands=["scope", SCOPE_USER])]
    if proj is not None:
        wanted.append(ExpressionNode(op=QueryOp.EQ, operands=["project_id", proj.project_id]))
    match = wanted[0] if len(wanted) == 1 else ExpressionNode(op=QueryOp.OR, operands=wanted)

    users: CredentialPairs = []
    projects: CredentialPairs = []
    for spec in await Credential.get_all(QueryFilter(match=match)):
        name = spec_scope_name(spec)
        if name == SCOPE_USER and _declared_under(spec, user):
            users.append((spec, user))
        elif (name == SCOPE_PROJECT and proj is not None
              and str(spec.project_id or "") == proj.project_id and _declared_under(spec, proj)):
            projects.append((spec, proj))
    return users + projects


def _declared_under(spec: "Credential", scope: CredentialScope) -> bool:
    """Whether this row still has a document, in the scope it claims.

    Two orthogonal ways a row stops being a declaration, and it takes both to
    catch them:

    *It is somewhere else.* A user-scope query matches on the STRING
    ``scope == "user"`` alone, which assumes there has only ever been one user
    home. A row written under a different one — another instance's
    ``user_home``, a relocated ``FLOW_HOME``, a test's temporary home — keeps
    answering as this home's declaration. (``SCOPE_PROJECT`` carries a
    ``project_id``, a real key; ``"user"`` identifies nothing, so containment
    stands in for the key user scope does not have. Giving it one is the deeper
    fix, and it needs a column and a backfill for a condition that only arises
    across homes.)

    *It is gone.* The folder was deleted and the row outlived it. Nothing prunes
    a fileless ``credential`` — ``prune_fileless_data_sources`` covers a NULL
    ``asset_ref`` on a data source, not a path that stopped existing.

    Either way the variables get injected into a process and snapshotted into a
    node's attachment list although nothing here declares them.

    A row with no ``asset_ref``, or a scope with no root, is left alone: those
    are shapes this predicate does not model, and dropping them silently would
    trade one wrong answer for another.
    """
    ref = getattr(spec, "asset_ref", "") or ""
    if not ref or scope.root is None:
        return True
    path, root = Path(ref), Path(scope.root)
    if not path.exists():
        return False
    # Both are normally written from the same root, so the plain comparison
    # answers with no filesystem access. Resolving is the fallback for the case
    # that needs it — a symlinked home, or macOS `/tmp` against `/private/tmp`.
    return path.is_relative_to(root) or path.resolve().is_relative_to(root.resolve())


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
    placement: Optional[Placement] = None,
) -> dict[str, SecretStr]:
    """Resolve every declared variable that ``only`` permits, at ``placement`` (default: this computer).

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
        return await read_values(targets, placement or await placement_for_deployment())
    except Exception as e:  # noqa: BLE001
        logger.debug("[credentials] could not resolve values: %s", type(e).__name__)
        return {}


async def placement_for(process: Any = None) -> Placement:
    """Where ``process`` reads its values: its Deployment's placement (:func:`placement_for_deployment`)."""
    return await placement_for_deployment(str(getattr(process, "deployment_id", "") or ""))


async def placement_for_deployment(deployment_id: str = "") -> Placement:
    """That Deployment's placement; else this computer's. Never raises: a process must start even
    when the lookup fails (it then reads this computer's default store in the instance's environment).
    """
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    deployment_id = deployment_id.strip()
    try:
        deployment = await Deployment.get_by_id(deployment_id) if deployment_id else None
        return await Placement.of(deployment)
    except Exception as e:  # noqa: BLE001
        from flow_sdk.instance_settings.environment import get_default_environment  # noqa: PLC0415
        from flow_sdk.schema.data_spec.deployment_secrets_spec import DeploymentSecretsSpec  # noqa: PLC0415

        logger.debug("[credentials] could not read the placement of %r: %s", deployment_id, e)
        return Placement(DeploymentSecretsSpec(), get_default_environment())


async def placement_for_source(row: Any) -> Placement:
    """Where a data source reads its values.

    The Deployment that answers it (``answer_place``); else the deployment this
    process serves (``FLOW_DEPLOYMENT_ID``); else this computer. A source syncing
    on a production box must read production values, not ``development``.
    """
    from flow_sdk.builtin.deployment_process import DEPLOYMENT_ENV  # noqa: PLC0415

    placed = str(getattr(row, "answer_place", "") or "").strip() or os.environ.get(DEPLOYMENT_ENV, "")
    return await placement_for_deployment(placed)


async def known_deployments() -> list["Deployment"]:
    """This computer first, then every other Deployment — every place a value may live."""
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    here = await Deployment.this_computer()
    try:
        rows = await Deployment.others()
    except Exception as e:  # noqa: BLE001
        logger.debug("[credentials] could not list deployments: %s", e)
        rows = []
    return [here, *rows]


async def known_placements() -> list[Placement]:
    """The placement of every known deployment (:func:`known_deployments`); one inheriting its
    binding reads this computer's, looked up once."""
    here, *rows = await known_deployments()
    inherited = here.secrets or DeploymentSecretsSpec()
    return [
        Placement(row.secrets or inherited, row.environment, str(row.id)) for row in (here, *rows)
    ]


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


async def resolve_attached_secrets(
    project: Optional["Project"], *, process: Any = None, placement: Optional[Placement] = None
) -> dict[str, SecretStr]:
    """The declared values the local node lets ``project``'s processes see, at ``placement`` — else
    where ``process``'s deployment (default: this computer) keeps them.

    The one entry point for spawns (worker, terminal, node command). Nothing
    declared — the common case — returns before the node and placement lookups.
    """
    declared = await declared_vars(project)
    if not declared:
        return {}
    return await resolve_project_secrets(
        project,
        only=await attached_env_vars_for(project),
        declared=declared,
        placement=placement or await placement_for(process),
    )
