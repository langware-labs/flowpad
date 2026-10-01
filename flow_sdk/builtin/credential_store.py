"""Where a credential's values are read and written.

A credential lives in a scope (``user`` or ``project``) and names variables; a Deployment says where
their values live (``DeploymentSecretsSpec``: a store, per-variable exceptions). A :class:`Placement`
is that binding plus the deployment's ``environment``, and :func:`secret_store_ref` is the ONE place a
scope, a variable and a placement become a store config. A local store type with no config is
completed per scope:

    env_file → <scope root>/.env.local (development) or .env.<env>.local
    vault    → prefix credential.[<env>.]user. / credential.[<env>.]project.<pid>.

The scope root is the asset scope root Flowpad already has
(``asset_placement.root_for_scope``): the project's mount, or the user's home.
Everything past the config is the store's own verbs (``flow_sdk.secrets``).
Values only flow out through :func:`read_values`, which the injection resolver
uses.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Iterable, Optional

from pydantic import SecretStr

from flow_sdk.schema.data_spec.credential_contract import (
    DEFAULT_ENVIRONMENT,
    SCOPE_PROJECT,
    SCOPE_SYSTEM,
    SCOPE_USER,
    vault_name,
)
from flow_sdk.schema.data_spec.credential_status_spec import StoreForgottenSpec
from flow_sdk.schema.data_spec.deployment_secrets_spec import DeploymentSecretsSpec
from flow_sdk.secrets import SecretStore, SecretStoreRef, load_all

if TYPE_CHECKING:
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class CredentialScope:
    """One place credentials are declared: the user, or one project."""

    scope: str
    project_id: Optional[str]
    root: Optional[Path]

    @property
    def key(self) -> tuple[str, Optional[str]]:
        return (self.scope, self.project_id)


def user_scope() -> CredentialScope:
    from flow_sdk.assets.placement import Scope  # noqa: PLC0415
    from flow_sdk.builtin.asset_placement import root_for_scope  # noqa: PLC0415

    return CredentialScope(SCOPE_USER, None, root_for_scope(Scope.USER))


def project_scope(project: "Project") -> CredentialScope:
    from flow_sdk.assets.placement import Scope  # noqa: PLC0415
    from flow_sdk.builtin.asset_placement import root_for_scope  # noqa: PLC0415

    mount = getattr(project, "fs_storage_mount_path", None)
    return CredentialScope(SCOPE_PROJECT, str(project.id), root_for_scope(Scope.PROJECT, project_mount=mount))


def spec_scope_name(spec: "Credential") -> Optional[str]:
    """``user`` / ``project`` / ``system`` for a spec row, or None if unplaced."""
    scope = getattr(spec, "scope", None)
    return scope if scope in (SCOPE_USER, SCOPE_PROJECT, SCOPE_SYSTEM) else None


async def scope_of(spec: "Credential") -> tuple[Optional[CredentialScope], Optional["Project"]]:
    """The scope a spec row declares for, and its project when project-scoped.

    ``(None, None)`` for templates and rows whose project is gone.
    """
    name = spec_scope_name(spec)
    if name == SCOPE_USER:
        return user_scope(), None
    if name == SCOPE_PROJECT and spec.project_id:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.get_by_id(str(spec.project_id))
        if project is not None:
            return project_scope(project), project
    return None, None


@dataclass(frozen=True)
class Placement:
    """Where credential values are read and written: a deployment's binding and its environment."""

    secrets: DeploymentSecretsSpec
    environment: str = DEFAULT_ENVIRONMENT
    deployment_id: str = ""

    @classmethod
    async def of(cls, deployment: Optional["Deployment"] = None) -> "Placement":
        """``deployment``'s placement; ``None`` is this computer's."""
        if deployment is None:
            from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

            deployment = await Deployment.this_computer()
        return cls(await deployment.secrets_binding(), deployment.environment or DEFAULT_ENVIRONMENT, str(deployment.id))

    def required(self, spec: "Credential") -> list[str]:
        """``spec``'s variables that must have a value here: its own required ones, plus what this
        deployment additionally requires."""
        extra = set(self.secrets.require)
        return [name for name, var in (spec.vars or {}).items() if var.is_must or name in extra]


def secret_store_ref(spec: "Credential", scope: CredentialScope, env_var: str, placement: Placement) -> SecretStoreRef:
    """The store ``placement`` keeps ``spec``'s ``env_var`` in, for ``scope``. No I/O."""
    environment = placement.environment
    if spec.lm_provider:
        # The funding resolver reads one entry per provider, whatever a deployment says.
        entry = vault_name(
            scope=scope.scope, project_id=scope.project_id, env_var=env_var,
            lm_provider=spec.lm_provider, environment=environment,
        )
        return SecretStoreRef(type="vault", config={"entries": {env_var: entry}})
    ref = placement.secrets.store_of(env_var)
    if ref.config:
        return ref
    if ref.type == "vault":
        prefix = vault_name(scope=scope.scope, project_id=scope.project_id, env_var="", environment=environment)
        return SecretStoreRef(type="vault", config={"prefix": prefix})
    if ref.type == "env_file":
        from flow_sdk.builtin.env_local_store import env_local_path  # noqa: PLC0415

        path = env_local_path(scope.root, environment)
        return SecretStoreRef(type="env_file", config={"env_file_path": str(path) if path else ""})
    return ref


async def write_value(
    spec: "Credential", scope: CredentialScope, env_var: str, value: str, placement: Placement
) -> None:
    """Store one variable's value where ``placement`` keeps it. Raises ``EnvLocalNotWritable``
    (with a code) or :class:`VaultNotEnabled`."""
    label = f"{spec.title or spec.name}: {env_var}"
    if placement.environment != DEFAULT_ENVIRONMENT:
        label = f"{label} ({placement.environment})"
    store = SecretStore.from_ref(secret_store_ref(spec, scope, env_var, placement))
    await store.save({env_var: value}, description=label)


async def read_values(
    targets: Iterable[tuple["Credential", CredentialScope, str]], placement: Placement
) -> dict[str, SecretStr]:
    """``placement``'s values for ``(spec, scope, env_var)`` targets, keyed by env var.

    Each store is read once: every env file is parsed once, and the encrypted
    vault is decrypted once, however many variables it holds. A store that
    cannot be read contributes nothing — a missing value must never take down a
    spawn — and only names are ever logged.
    """
    stores: dict[tuple[str, str], tuple[SecretStore, list[str]]] = {}
    for spec, scope, env_var in targets:
        ref = secret_store_ref(spec, scope, env_var, placement)
        stores.setdefault(ref.key, (SecretStore.from_ref(ref), []))[1].append(env_var)
    out: dict[str, SecretStr] = {}
    for values in await load_all(stores.values()):
        out.update(values)
    return out


async def forget_in(refs: Iterable[SecretStoreRef], names: Iterable[str]) -> list[StoreForgottenSpec]:
    """Remove ``names`` from every store in ``refs`` (each place once), one report per store.

    A store that raises is reported with its error and every name counted as kept — a store is
    never silently skipped.
    """
    names = list(dict.fromkeys(names))
    reports: list[StoreForgottenSpec] = []
    seen: set[tuple[str, str]] = set()
    for ref in refs:
        if ref.key in seen:
            continue
        seen.add(ref.key)
        store = SecretStore.from_ref(ref)
        report = {"type": ref.type, "where": store.where}
        try:
            deleted, kept = await store.forget(names)
        except Exception as e:  # noqa: BLE001 — reported, never raised past the other stores
            reports.append(StoreForgottenSpec(**report, kept=names, error=f"{type(e).__name__}: {e}"))
            continue
        reports.append(StoreForgottenSpec(**report, deleted=deleted, kept=kept))
    return reports


async def forget_values(
    spec: "Credential", scope: CredentialScope, placements: Iterable[Placement]
) -> list[StoreForgottenSpec]:
    """Delete the values a credential owns in every store any of ``placements`` keeps them in, one report each."""
    refs = [secret_store_ref(spec, scope, name, placement) for placement in placements for name in spec.var_names()]
    return await forget_in(refs, spec.var_names())
