"""The value-free status of every credential a project (and the user) declares.

Reads each store once: one ``.env.local`` listing and one git probe per scope
root, and one vault listing. Values are never read.
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Optional

from flow_sdk.builtin.credential_resolver import credentials_in_scope, declare
from flow_sdk.builtin.credential_store import CredentialScope, project_scope, user_scope
from flow_sdk.schema.data_spec.credential_contract import VALUE_STORE_ENV, VALUE_STORE_VAULT
from flow_sdk.schema.data_spec.credential_status_spec import (
    CredentialsStatusSpec,
    CredentialStatusRowSpec,
    CredentialVarStatusSpec,
    DetectedKeySpec,
    ScopeFileStatusSpec,
)

if TYPE_CHECKING:
    from flow_sdk.builtin.credential_spec import CredentialSpec
    from flow_sdk.builtin.project import Project


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


def _file_status(scope: CredentialScope) -> tuple[dict, list[dict]]:
    from flow_sdk.builtin.env_local_store import (  # noqa: PLC0415
        env_local_block,
        env_local_path,
        gitignore_status,
        list_env_local,
    )

    path = env_local_path(scope.root)
    block = env_local_block(gitignore_status(scope.root))
    head = {
        "path": str(path) if path is not None else None,
        "exists": bool(path is not None and path.exists()),
        "blocked": block is not None,
        "block_code": block["code"] if block else None,
        "block_reason": block["reason"] if block else None,
    }
    return head, list_env_local(scope.root)


def _in_vault(spec: "CredentialSpec", scope: CredentialScope, env_var: str, names: set[str]) -> bool:
    """Whether the vault holds this variable — checked for either store, so a
    value kept in the store the credential does not read shows as ``wrong-store``."""
    from flow_sdk.schema.data_spec.credential_contract import vault_name  # noqa: PLC0415

    try:
        name = vault_name(
            scope=scope.scope, project_id=scope.project_id, env_var=env_var, lm_provider=spec.lm_provider or ""
        )
    except ValueError:  # a hand-authored provider key outside the user scope has no vault name
        return False
    return name in names


async def credentials_status(project: Optional["Project"]) -> CredentialsStatusSpec:
    pairs = await credentials_in_scope(project)
    declared = declare(pairs)
    vault_enabled, vault_names = await asyncio.to_thread(_vault_names)

    scopes = [user_scope()] + ([project_scope(project)] if project is not None else [])
    files = await asyncio.gather(*(asyncio.to_thread(_file_status, s) for s in scopes))
    env_keys = {s.key: {row["key"] for row in rows} for s, (_, rows) in zip(scopes, files)}

    rows: list[CredentialStatusRowSpec] = []
    for spec, scope in pairs:
        keys = env_keys.get(scope.key, set())
        var_rows: list[CredentialVarStatusSpec] = []
        for env_var, var in (spec.vars or {}).items():
            in_env = env_var in keys
            in_vault = _in_vault(spec, scope, env_var, vault_names)
            present = in_vault if spec.value_store == VALUE_STORE_VAULT else in_env
            found_in = VALUE_STORE_VAULT if in_vault else (VALUE_STORE_ENV if in_env else None)
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
                    required=var.required,
                    present=present,
                    found_in=found_in,
                    warning=None if present else ("wrong-store" if found_in else "missing"),
                    shadowed_by=shadowed_by,
                )
            )
        required = set(spec.required_var_names() or spec.var_names())
        met = [v for v in var_rows if v.present]
        if all(v.present for v in var_rows if v.env_var in required):
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
                scope=scope.scope,
                project_id=scope.project_id,
                value_store=spec.value_store,
                lm_provider=spec.lm_provider or "",
                state=state,
                vars=var_rows,
            )
        )

    file_rows: list[ScopeFileStatusSpec] = []
    for scope, (head, keys) in zip(scopes, files):
        file_rows.append(
            ScopeFileStatusSpec(
                scope=scope.scope,
                project_id=scope.project_id,
                **head,
                detected=[
DetectedKeySpec(key=row["key"], line=row["line"]) for row in keys
                ],
            )
        )

    return CredentialsStatusSpec(
        project_id=str(project.id) if project is not None else None,
        vault_enabled=vault_enabled,
        credentials=rows,
        files=file_rows,
    )
