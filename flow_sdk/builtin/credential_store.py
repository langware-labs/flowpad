"""Where a credential's values are read and written.

A credential lives in a scope (``user`` or ``project``) and names a store type
(``env`` or ``vault``) per environment. :func:`secret_store_ref` is the ONE place
a scope and an environment become a store config:

    env   → env_file, <scope root>/.env.local (development) or .env.<env>.local
    vault → vault, prefix credential.[<env>.]user. / credential.[<env>.]project.<pid>.

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
    VALUE_STORE_VAULT,
    vault_name,
)
from flow_sdk.secrets import SecretStore, SecretStoreRef, load_all

if TYPE_CHECKING:
    from flow_sdk.builtin.secret_pack import SecretPack
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


def spec_scope_name(spec: "SecretPack") -> Optional[str]:
    """``user`` / ``project`` / ``system`` for a spec row, or None if unplaced."""
    scope = getattr(spec, "scope", None)
    return scope if scope in (SCOPE_USER, SCOPE_PROJECT, SCOPE_SYSTEM) else None


async def scope_of(spec: "SecretPack") -> tuple[Optional[CredentialScope], Optional["Project"]]:
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


def secret_store_ref(
    spec: "SecretPack", scope: CredentialScope, environment: str = DEFAULT_ENVIRONMENT
) -> SecretStoreRef:
    """The store ``spec`` keeps ``environment``'s values in, for ``scope``. No I/O."""
    if spec.store_for(environment) == VALUE_STORE_VAULT:
        if spec.lm_provider:
            # One entry per provider, whatever the variable is called.
            entries = {
                env_var: vault_name(
                    scope=scope.scope,
                    project_id=scope.project_id,
                    env_var=env_var,
                    lm_provider=spec.lm_provider,
                    environment=environment,
                )
                for env_var in spec.var_names()
            }
            return SecretStoreRef(type="vault", config={"entries": entries})
        prefix = vault_name(scope=scope.scope, project_id=scope.project_id, env_var="", environment=environment)
        return SecretStoreRef(type="vault", config={"prefix": prefix})
    from flow_sdk.builtin.env_local_store import env_local_path  # noqa: PLC0415

    path = env_local_path(scope.root, environment)
    return SecretStoreRef(type="env_file", config={"env_file_path": str(path) if path else ""})


async def write_value(
    spec: "SecretPack",
    scope: CredentialScope,
    env_var: str,
    value: str,
    environment: str = DEFAULT_ENVIRONMENT,
) -> None:
    """Store one variable's value where the spec says for ``environment``. Raises
    ``EnvLocalNotWritable`` (with a code) or :class:`VaultNotEnabled`."""
    label = f"{spec.title or spec.name}: {env_var}"
    if environment != DEFAULT_ENVIRONMENT:
        label = f"{label} ({environment})"
    store = SecretStore.from_ref(secret_store_ref(spec, scope, environment))
    await store.save({env_var: value}, description=label)


async def read_values(
    targets: Iterable[tuple["SecretPack", CredentialScope, str]],
    environment: str = DEFAULT_ENVIRONMENT,
) -> dict[str, SecretStr]:
    """``environment``'s values for ``(spec, scope, env_var)`` targets, keyed by env var.

    Each store is read once: every env file is parsed once, and the encrypted
    vault is decrypted once, however many variables it holds. A store that
    cannot be read contributes nothing — a missing value must never take down a
    spawn — and only names are ever logged.
    """
    stores: dict[tuple[str, str], tuple[SecretStore, list[str]]] = {}
    for spec, scope, env_var in targets:
        ref = secret_store_ref(spec, scope, environment)
        stores.setdefault(ref.key, (SecretStore.from_ref(ref), []))[1].append(env_var)
    out: dict[str, SecretStr] = {}
    for values in await load_all(stores.values()):
        out.update(values)
    return out


async def forget_values(
    spec: "SecretPack",
    scope: CredentialScope,
    environments: Iterable[str] = (DEFAULT_ENVIRONMENT,),
) -> tuple[list[str], list[str]]:
    """Delete the values a credential owns in every given environment: ``(deleted, kept)`` names.

    Vault entries are Flowpad's own and are removed. Env file lines are the
    user's and are always kept, so a variable read from a file in any
    environment is reported as kept.
    """
    names = spec.var_names()
    deleted: set[str] = set()
    kept: set[str] = set()
    seen: set[tuple[str, str]] = set()
    for environment in environments:
        ref = secret_store_ref(spec, scope, environment)
        if ref.key in seen:
            continue
        seen.add(ref.key)
        gone, stay = await SecretStore.from_ref(ref).forget(names)
        deleted.update(gone)
        kept.update(stay)
    return [n for n in names if n in deleted and n not in kept], [n for n in names if n in kept]
