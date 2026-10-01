"""The value-free status of every credential a project (and the user) declares,
at one deployment (default: this computer).

Reads each store once: one env-file listing and one git probe per scope root,
one vault listing, and one name listing per remote store a variable lives in.
Values are never read.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Optional

from flow_sdk.builtin.credential_files import credential_file
from flow_sdk.builtin.credential_resolver import (
    credentials_in_scope,
    declare,
    known_deployments,
    placement_for_deployment,
)
from flow_sdk.builtin.credential_store import CredentialScope, project_scope, secret_store_ref, user_scope
from flow_sdk.schema.data_spec.credential_contract import (
    VALUE_STORE_ENV,
    VALUE_STORE_VAULT,
    CredentialVarKind,
    as_requirement,
    vault_name,
)
from flow_sdk.schema.data_spec.credential_status_spec import (
    CredentialsStatusSpec,
    CredentialStatusRowSpec,
    CredentialVarStatusSpec,
    DeploymentChoiceSpec,
    DetectedKeySpec,
    ScopeFileStatusSpec,
)
from flow_sdk.schema.data_spec.deployment_secrets_spec import LOCAL_STORE_TYPES, store_word

if TYPE_CHECKING:
    from flow_sdk.builtin.project import Project
    from flow_sdk.secrets import SecretStoreRef

def _vault_names() -> tuple[bool, set[str]]:
    from flow_sdk.cli.auth.secrets import get_secrets, is_secrets_enabled  # noqa: PLC0415

    try:
        enabled = is_secrets_enabled()
    except Exception:  # noqa: BLE001
        enabled = False
    try:
        names = {str(row.get("name") or "") for row in get_secrets()}
    except Exception:  # noqa: BLE001
        names = set()
    return enabled, names


def _file_status(scope: CredentialScope, environment: str) -> list[tuple[dict, list[dict]]]:
    """``(head, keys)`` per env file the scope reads: the written one first, then its declared extras.

    Only the written file can be blocked — an extra is read, never written, so git has no say."""
    from flow_sdk.builtin.env_local_store import (  # noqa: PLC0415
        env_local_block,
        gitignore_status,
        list_env_file,
    )

    out: list[tuple[dict, list[dict]]] = []
    for path, declared in scope.env_files(environment):
        block = env_local_block(gitignore_status(scope.root, environment)) if declared is None else None
        head = {
            "path": str(path) if path is not None else None,
            "exists": bool(path is not None and path.is_file()),
            "extra_path": declared,
            "blocked": block is not None,
            "block_code": block["code"] if block else None,
            "block_reason": block["reason"] if block else None,
        }
        out.append((head, list_env_file(path)))
    return out


def _in_vault(spec, scope: CredentialScope, env_var: str, environment: str, names: set[str]) -> bool:
    """Whether the vault holds this variable at this environment — asked for either local store, so a
    value kept in the store the deployment does not read shows as ``wrong-store``."""
    try:
        name = vault_name(scope=scope.scope, project_id=scope.project_id, env_var=env_var,
                          lm_provider=spec.lm_provider or "", environment=environment)
    except ValueError:  # a provider key outside its rules has no vault name
        return False
    return name in names


async def _remote_names(refs: list["SecretStoreRef"]) -> dict[tuple[str, str], Optional[set[str]]]:
    """``{ref.key: names}`` for each remote store; ``None`` for one that could not be asked."""
    from flow_sdk.secrets import SecretStore  # noqa: PLC0415

    async def names(ref: "SecretStoreRef") -> Optional[set[str]]:
        try:
            return set(await SecretStore.from_ref(ref).names())
        except Exception:  # noqa: BLE001 — reported per variable as unreachable
            return None

    unique = list({ref.key: ref for ref in refs}.values())
    return dict(zip((ref.key for ref in unique), await asyncio.gather(*(names(ref) for ref in unique))))


async def credentials_status(project: Optional["Project"], deployment_id: str = "") -> CredentialsStatusSpec:
    placement = await placement_for_deployment(deployment_id)
    environment = placement.environment
    pairs = await credentials_in_scope(project)
    declared = declare(pairs)
    (vault_enabled, vault_names), deployments = await asyncio.gather(asyncio.to_thread(_vault_names), known_deployments())

    scopes = [user_scope()] + ([project_scope(project)] if project is not None else [])
    files = await asyncio.gather(*(asyncio.to_thread(_file_status, s, environment) for s in scopes))
    # A variable is in a scope's env store when ANY file it reads holds it — the store reads them all.
    env_keys = {s.key: {row["key"] for _, rows in per_scope for row in rows} for s, per_scope in zip(scopes, files)}

    refs = {(str(spec.id), name): secret_store_ref(spec, scope, name, placement) for spec, scope in pairs for name in spec.var_names()}
    remote = await _remote_names([ref for ref in refs.values() if ref.type not in LOCAL_STORE_TYPES])

    rows: list[CredentialStatusRowSpec] = []
    for spec, scope in pairs:
        keys = env_keys.get(scope.key, set())
        var_rows: list[CredentialVarStatusSpec] = []
        required = set(placement.required(spec))
        stores: set[str] = set()
        for env_var, var in (spec.vars or {}).items():
            ref = refs[(str(spec.id), env_var)]
            store = store_word(ref)
            stores.add(store)
            if ref.type in LOCAL_STORE_TYPES:
                in_env = env_var in keys
                in_vault = _in_vault(spec, scope, env_var, environment, vault_names)
                present = in_vault if ref.type == "vault" else in_env
                if present and var.kind is CredentialVarKind.FILE:
                    # The store holds the file's path; the value is only there if the file is.
                    present = credential_file(spec, scope, env_var, environment).is_file()
                found_in = VALUE_STORE_VAULT if in_vault else (VALUE_STORE_ENV if in_env else None)
                warning = None if present else ("wrong-store" if found_in else "missing")
            else:
                held = remote.get(ref.key)
                present = held is not None and env_var in held
                found_in = store if present else None
                warning = None if present else ("unreachable" if held is None else "missing")
            winner = declared.get(env_var)
            shadowed_by = str(winner.spec.typeid) if winner is not None and winner.spec.id != spec.id else None
            var_rows.append(
                CredentialVarStatusSpec(
                    env_var=env_var,
                    label=var.label,
                    hint=var.hint,
                    placeholder=var.placeholder,
                    pattern=var.pattern,
                    help_url=var.help_url,
                    secret=var.secret,
                    required=as_requirement(env_var in required),
                    kind=var.kind,
                    store=store,
                    present=present,
                    found_in=found_in,
                    warning=warning,
                    shadowed_by=shadowed_by,
                )
            )
        needed = required or set(spec.var_names())
        met = [v for v in var_rows if v.present]
        if all(v.present for v in var_rows if v.env_var in needed):
            state = "connected"
        elif met:
            state = "partial"
        else:
            state = "missing"
        rows.append(
            CredentialStatusRowSpec(
                typeid=str(spec.typeid),
                name=str(spec.name or ""),
                title=spec.title or str(spec.name or ""),
                description=spec.description or "",
                icon_name=spec.icon_name or "",
                help_url=spec.help_url or "",
                setup_wiki=getattr(spec, "setup_wiki", "") or "",
                setup=getattr(spec, "setup", "") or "",
                setup_timeout_seconds=getattr(spec, "setup_timeout_seconds", None),
                scope=scope.scope,
                project_id=scope.project_id,
                environment=environment,
                value_store=next(iter(stores)) if len(stores) == 1 else "mixed",
                lm_provider=spec.lm_provider or "",
                state=state,
                vars=var_rows,
            )
        )

    file_rows = [
        ScopeFileStatusSpec(
            scope=scope.scope,
            project_id=scope.project_id,
            environment=environment,
            **head,
            detected=[DetectedKeySpec(key=row["key"], line=row["line"]) for row in keys],
        )
        for scope, per_scope in zip(scopes, files)
        for head, keys in per_scope
    ]

    return CredentialsStatusSpec(
        project_id=str(project.id) if project is not None else None,
        deployment_id=placement.deployment_id,
        environment=environment,
        deployments=[
            DeploymentChoiceSpec(
                id=str(row.id), name=row.name or "", environment=row.environment or environment,
                this_computer=row.is_this_computer,
            )
            for row in deployments
        ],
        vault_enabled=vault_enabled,
        credentials=rows,
        files=file_rows,
    )

