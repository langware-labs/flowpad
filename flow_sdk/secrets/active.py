"""The active secret vault — the ONE a target (an entity, a project, this instance) reads a missing secret from.

    active = await active_vault_of(target)                    # None: no vault anywhere
    values = await read_secrets(["STRIPE_API_KEY"], target)   # the environment first, else that vault; never writes

The most specific scope wins (:class:`SecretScope`):

==========  ======================================================================================
``entity``  the target's own ``secret_vault()`` — a project vault's name, or a vault of its own
``project`` its project's ``default_secret_vault``, else the first of ``secret_vaults`` by name
``global``  this instance's vault (``preferences.json``, :data:`PREF_GLOBAL_VAULT`)
==========  ======================================================================================

Only :func:`read_secrets` runs a manager's command line, and a caller asks for it by name: describing a
vault never raises an unlock prompt.
"""
from __future__ import annotations

import os
from enum import StrEnum
from pathlib import Path
from typing import Any, ClassVar, Iterable, Optional

from pydantic import SecretStr

from flow_sdk.schema.data_spec.secret_vault_spec import SecretVaultSpec
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.secrets.errors import MissingSecrets, SecretStoreError

#: This instance's vault, used where no project or entity names one: ``{manager, config}``.
PREF_GLOBAL_VAULT = "preferences.secrets.vault"


class SecretScope(StrEnum):
    ENTITY = "entity"
    PROJECT = "project"
    GLOBAL = "global"


class ActiveVaultSpec(DataSpec):
    """One vault as a screen or an agent sees it: where it was declared and whether this computer can use it.
    Never a value."""

    spec_kind: ClassVar[str] = "secrets.active_vault"

    scope: SecretScope
    name: str
    vault: SecretVaultSpec
    #: The manager's title (``1Password``); its name when the manager is unknown here.
    manager_title: str = ""
    #: The manager's command line when it is not on this computer (or the unknown manager's name), else "".
    missing_tool: str = ""
    #: This computer has what the manager needs (its command line). Signed in or not is only known by asking it.
    usable: bool = True
    #: A project vault: it is the project's default.
    is_default: bool = False


class NoActiveVault(SecretStoreError, LookupError):
    """Nothing names a vault here: not the target, not its project, not this instance."""

    code = "no_vault"


def describe(scope: SecretScope, name: str, vault: SecretVaultSpec, *, is_default: bool = False) -> ActiveVaultSpec:
    from flow_sdk.secrets import managers  # noqa: PLC0415  (lazy: managers load assets)

    missing = managers.missing_tool(vault)
    return ActiveVaultSpec(scope=scope, name=name, vault=vault, manager_title=managers.title_of(vault.manager),
                           missing_tool=missing, usable=not missing, is_default=is_default)


def global_vault() -> Optional[ActiveVaultSpec]:
    """This instance's vault, or None when it names none (or an unreadable one)."""
    from flow_sdk.preferences import read_instance_pref  # noqa: PLC0415

    raw = read_instance_pref(PREF_GLOBAL_VAULT, None)
    if not isinstance(raw, dict) or not raw.get("manager"):
        return None
    try:
        vault = SecretVaultSpec.model_validate({"manager": raw["manager"], "config": raw.get("config") or {}})
    except ValueError:
        return None
    return describe(SecretScope.GLOBAL, SecretScope.GLOBAL.value, vault)


def set_global_vault(vault: Optional[SecretVaultSpec]) -> None:
    """Name (or, with None, clear) this instance's vault. Raises ``UnknownSecretManager`` for a manager not installed here."""
    from flow_sdk.preferences import write_instance_pref  # noqa: PLC0415
    from flow_sdk.secrets import managers  # noqa: PLC0415

    if vault is not None:
        managers.get_manager(vault.manager)
    write_instance_pref(PREF_GLOBAL_VAULT, vault.model_dump(mode="json") if vault is not None else None)


def project_vaults(project: Any) -> list[ActiveVaultSpec]:
    """The project's vaults, its default first then by name — one manifest read. [] when it has none."""
    from flow_sdk.assets.project_manifest import read_secret_vault_setup  # noqa: PLC0415

    root = getattr(project, "fs_storage_mount_path", None) if project is not None else None
    vaults, named = read_secret_vault_setup(Path(root)) if root else ({}, "")
    default = named if named in vaults else min(vaults, default="")
    return [describe(SecretScope.PROJECT, name, vaults[name], is_default=name == default)
            for name in sorted(vaults, key=lambda n: (n != default, n))]


def active_among(rows: list[ActiveVaultSpec], chosen: Any = None, *, entity_name: str = "") -> Optional[ActiveVaultSpec]:
    """The vault in use given a project's ``rows`` and an entity's own choice (a row's name, a vault, or None)."""
    if isinstance(chosen, SecretVaultSpec):
        return describe(SecretScope.ENTITY, entity_name, chosen)
    own = next((row for row in rows if chosen and row.name == chosen), None)
    if own is not None:
        return own.model_copy(update={"scope": SecretScope.ENTITY})
    return next((row for row in rows if row.is_default), None) or global_vault()


async def active_vault_of(target: Any = None) -> Optional[ActiveVaultSpec]:
    """The vault ``target`` uses — an entity or a project; None is this instance's vault alone."""
    from flow_sdk.builtin.asset_publishing import owning_project  # noqa: PLC0415
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    if target is None:
        return global_vault()
    project = target if isinstance(target, Project) else await owning_project(target)
    own = getattr(target, "secret_vault", None)
    return active_among(project_vaults(project), own() if callable(own) else None, entity_name=str(getattr(target, "name", "") or ""))


async def read_secrets(names: Iterable[str], target: Any = None) -> dict[str, SecretStr]:
    """Every one of ``names``: from this process's environment when it is there, else from ``target``'s active
    vault. Never writes. Raises :class:`NoActiveVault`, ``MissingSecrets`` (the vault lacks some) or the store's
    own error (not installed, sign-in needed, denied)."""
    from flow_sdk.secrets import managers  # noqa: PLC0415

    names = list(dict.fromkeys(names))
    held = {name: SecretStr(os.environ[name]) for name in names if os.environ.get(name)}
    wanted = [name for name in names if name not in held]
    if not wanted:
        return held
    active = await active_vault_of(target)
    if active is None:
        raise NoActiveVault(f"{', '.join(wanted)} not in the environment, and no secret vault is set here or on this instance")
    found = await managers.store_for(active.vault).load(wanted)
    missing = [name for name in wanted if name not in found]
    if missing:
        raise MissingSecrets(missing, store=f"{active.name} vault")
    return {**held, **found}


__all__ = [
    "PREF_GLOBAL_VAULT", "ActiveVaultSpec", "NoActiveVault", "SecretScope", "active_among", "active_vault_of",
    "describe", "global_vault", "project_vaults", "read_secrets", "set_global_vault",
]
