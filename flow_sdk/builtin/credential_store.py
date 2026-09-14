"""Where a credential's values are read and written.

A credential lives in a scope (``user`` or ``project``) and names a store
(``env`` or ``vault``). The pair decides one location per variable:

    env   → <scope root>/.env.local, key VAR
    vault → the encrypted per-instance store, entry ``vault_name(...)``

The scope root is the asset scope root Flowpad already has
(``asset_placement.root_for_scope``): the project's mount, or the user's home.
Values only flow out through :func:`read_values`, which the injection resolver
uses.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Iterable, Optional

from flow_sdk.schema.data_spec.credential_contract import (
    SCOPE_PROJECT,
    SCOPE_SYSTEM,
    SCOPE_USER,
    VALUE_STORE_VAULT,
    vault_name,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.credential_spec import CredentialSpec
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

VAULT_DISABLED = "vault-disabled"


class VaultNotEnabled(RuntimeError):
    """The encrypted store has not been enabled on this machine yet."""

    code = VAULT_DISABLED


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


def spec_scope_name(spec: "CredentialSpec") -> Optional[str]:
    """``user`` / ``project`` / ``system`` for a spec row, or None if unplaced."""
    scope = getattr(spec, "scope", None)
    return scope if scope in (SCOPE_USER, SCOPE_PROJECT, SCOPE_SYSTEM) else None


async def scope_of(spec: "CredentialSpec") -> tuple[Optional[CredentialScope], Optional["Project"]]:
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


def location_name(spec: "CredentialSpec", scope: CredentialScope, env_var: str) -> str:
    """Where one variable's value lives, as a name: the vault entry or the env key."""
    if spec.value_store == VALUE_STORE_VAULT:
        return vault_name(
            scope=scope.scope, project_id=scope.project_id, env_var=env_var, lm_provider=spec.lm_provider or ""
        )
    return env_var


def write_value(spec: "CredentialSpec", scope: CredentialScope, env_var: str, value: str) -> None:
    """Store one variable's value where the spec says. Raises
    ``EnvLocalNotWritable`` (with a code) or :class:`VaultNotEnabled`."""
    if spec.value_store == VALUE_STORE_VAULT:
        from flow_sdk.cli.auth.secrets import is_secrets_enabled, write_secret  # noqa: PLC0415

        if not is_secrets_enabled():
            raise VaultNotEnabled("The encrypted vault is not enabled on this machine.")
        write_secret(location_name(spec, scope, env_var), value, f"{spec.title or spec.name}: {env_var}")
        return
    from flow_sdk.builtin.env_local_store import write_env_local  # noqa: PLC0415

    write_env_local(scope.root, env_var, value)


def _load_vault() -> dict[str, str]:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return dict(get_instance_settings().sod.load_file().sodot)


async def read_values(targets: Iterable[tuple["CredentialSpec", CredentialScope, str]]) -> dict[str, str]:
    """Values for ``(spec, scope, env_var)`` targets, keyed by env var.

    Each store is read once: every scope root's ``.env.local`` is parsed once,
    and the encrypted vault is decrypted once, however many variables it holds.
    A store that cannot be read contributes nothing — a missing value must never
    take down a spawn — and only names are ever logged.
    """
    from flow_sdk.builtin.env_local_store import read_env_local_values  # noqa: PLC0415

    targets = list(targets)
    roots = {scope.root for spec, scope, _ in targets if spec.value_store != VALUE_STORE_VAULT}
    wants_vault = any(spec.value_store == VALUE_STORE_VAULT for spec, _, _ in targets)

    async def env_file(root: Optional[Path]) -> tuple[Optional[Path], dict[str, str]]:
        try:
            return root, await asyncio.to_thread(read_env_local_values, root)
        except Exception as e:  # noqa: BLE001
            logger.debug("[credentials] could not read .env.local at %s: %s", root, e)
            return root, {}

    async def vault() -> dict[str, str]:
        if not wants_vault:
            return {}
        try:
            return await asyncio.to_thread(_load_vault)
        except Exception as e:  # noqa: BLE001
            logger.debug("[credentials] could not read the vault: %s", type(e).__name__)
            return {}

    files, vault_values = await asyncio.gather(asyncio.gather(*(env_file(r) for r in roots)), vault())
    env_files = dict(files)

    out: dict[str, str] = {}
    for spec, scope, env_var in targets:
        if spec.value_store == VALUE_STORE_VAULT:
            value = vault_values.get(location_name(spec, scope, env_var))
        else:
            value = env_files.get(scope.root, {}).get(env_var)
        if value is not None:
            out[env_var] = value
    return out


async def forget_values(spec: "CredentialSpec", scope: CredentialScope) -> tuple[list[str], list[str]]:
    """Delete the values a credential owns: ``(deleted, kept)`` variable names.

    Vault entries are Flowpad's own and are removed. ``.env.local`` lines are the
    user's and are always kept.
    """
    names = spec.var_names()
    if spec.value_store != VALUE_STORE_VAULT:
        return [], names
    from flow_sdk.cli.auth.secrets import delete_secret  # noqa: PLC0415

    deleted: list[str] = []
    kept: list[str] = []
    for env_var in names:
        try:
            await delete_secret(location_name(spec, scope, env_var))
            deleted.append(env_var)
        except Exception as e:  # noqa: BLE001
            logger.warning("[credentials] could not delete the vault value for %s: %s", env_var, e)
            kept.append(env_var)
    return deleted, kept
