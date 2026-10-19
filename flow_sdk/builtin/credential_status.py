"""The value-free status of every credential a project (and the user) declares,
at one deployment (default: this computer).

Reads each store once: one env-file listing and one git probe per scope root,
one vault listing, and one name listing per remote store a variable lives in.
Values are never read.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
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
    CredentialRequirement,
    CredentialVarKind,
    vault_name,
)
from flow_sdk.schema.data_spec.credential_status_spec import (
    CredentialsStatusSpec,
    CredentialStatusRowSpec,
    CredentialVarStatusSpec,
    DeploymentChoiceSpec,
    DetectedKeySpec,
    EnvFallbackStatusSpec,
    ScopeFileStatusSpec,
    group_held,
)
from flow_sdk.schema.data_spec.deployment_secrets_spec import LOCAL_STORE_TYPES, store_word

if TYPE_CHECKING:
    from flow_sdk.builtin.credential import Credential
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


def _file_status(scope: CredentialScope, environment: str) -> tuple[ScopeFileStatusSpec, set[str]]:
    """The scope's written env file — with the files it falls back to, as ``fallbacks`` — and every
    key any of them holds: the store reads them all, so a variable in any one is present."""
    from flow_sdk.builtin.env_local_store import env_local_block, gitignore_status, list_env_file  # noqa: PLC0415

    def detected(rows: list[dict]) -> list[DetectedKeySpec]:
        return [DetectedKeySpec(key=row["key"], line=row["line"]) for row in rows]

    (path, _), *declared = scope.env_files(environment)
    rows = list_env_file(path)
    keys = {row["key"] for row in rows}
    fallbacks = []
    for extra, rel in declared:
        extra_rows = list_env_file(extra)
        keys.update(row["key"] for row in extra_rows)
        fallbacks.append(
            EnvFallbackStatusSpec(path=str(extra), extra_path=rel, exists=extra.is_file(), detected=detected(extra_rows))
        )
    block = env_local_block(gitignore_status(scope.root, environment))
    head = ScopeFileStatusSpec(
        scope=scope.scope,
        project_id=scope.project_id,
        environment=environment,
        path=str(path) if path is not None else None,
        exists=bool(path is not None and path.is_file()),
        blocked=block is not None,
        block_code=block["code"] if block else None,
        block_reason=block["reason"] if block else None,
        detected=detected(rows),
        fallbacks=fallbacks,
    )
    return head, keys


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


async def _signed_in(var) -> bool:
    """A ``cli`` variable's own check, run on this computer: exit 0 is signed in. A tool that is not
    installed, or a check with no command for this OS, is not signed in."""
    from flow_sdk.core.compute.exec import run_shell  # noqa: PLC0415
    from flow_sdk.schema.data_spec.compute_op_spec import CHECK_TIMEOUT  # noqa: PLC0415

    command = var.check.command_for() if var.check is not None else None
    if not command:
        return False
    said = await run_shell(command, timeout_seconds=var.check.timeout(CHECK_TIMEOUT), workdir=Path.home())
    return said.returncode == 0 and not said.timed_out


def _grant_key(provider: str, scopes) -> tuple[str, tuple[str, ...]]:
    return str(provider or "").lower(), tuple(scopes or ())


async def oauth_states(specs: list["Credential"]) -> dict[tuple[str, tuple[str, ...]], tuple[str, list[str]]]:
    """``{(provider, scopes): (state, missing scopes)}`` for every grant ``specs`` ask for — an oauth credential's,
    and an ``oauth`` way of an env credential's ONE_OF group — read from the ONE truth about grants (the
    connection list, ``core/connections/specs``), and the SDK's own scope check for what a held grant covers,
    checked on the grant already in hand. Never a store read: a grant is no variable."""
    from flow_sdk.connections import MissingScopes, _from_spec  # noqa: PLC0415
    from flow_sdk.core.connections.specs import _list_connection_specs_local, match_provider  # noqa: PLC0415
    from flow_sdk.schema.data_spec.connection_spec import ConnectionState  # noqa: PLC0415

    wanted = list(dict.fromkeys(
        [_grant_key(spec.provider, spec.scopes) for spec in specs if spec.is_oauth]
        + [_grant_key(var.provider, var.scopes) for spec in specs if not spec.is_oauth
           for var in (spec.vars or {}).values() if var.is_oauth]
    ))
    if not wanted:
        return {}
    try:
        grants = await _list_connection_specs_local()
    except Exception:  # noqa: BLE001 — no answer about grants reads as not connected, never an error page
        grants = []
    out: dict[tuple[str, tuple[str, ...]], tuple[str, list[str]]] = {}
    for key in wanted:
        provider, scopes = key
        grant = match_provider(grants, provider)
        if grant is None or grant.state is ConnectionState.DISCONNECTED:
            out[key] = ("missing", [])
        elif grant.state is ConnectionState.NEEDS_REAUTH:
            out[key] = ("needs_reauth", [])
        else:
            try:
                await _from_spec(grant).validate_scopes(list(scopes))
                out[key] = ("connected", [])
            except MissingScopes as e:
                out[key] = ("partial", list(e.missing))
    return out


def _requirement(var, must_here: bool) -> CredentialRequirement:
    """What this deployment needs of ``var``: its own word, raised to MUST when the deployment requires it."""
    if must_here:
        return CredentialRequirement.MUST
    return CredentialRequirement.ONE_OF if var.is_one_of else CredentialRequirement.OPTIONAL


@dataclass
class _Draft:
    """An ``env`` credential's row while its sign-ins are still being asked."""

    spec: "Credential"
    vars: list[CredentialVarStatusSpec]
    required: set[str]
    fields: dict

    def settle(self) -> CredentialStatusRowSpec:
        has_group = any(v.is_one_of for v in self.vars)
        needed = self.required or (set() if has_group else {v.env_var for v in self.vars})
        if all(v.present for v in self.vars if v.env_var in needed) and group_held(self.vars, self.spec.chosen):
            state = "connected"
        elif any(v.present for v in self.vars):
            state = "partial"
        else:
            state = "missing"
        return CredentialStatusRowSpec(**self.fields, state=state, vars=self.vars)


async def credentials_status(
    project: Optional["Project"], deployment_id: str = "", *, sign_ins: bool = True
) -> CredentialsStatusSpec:
    """``sign_ins=False``: a ``cli`` variable's check (a process) is not run and it reads as not signed
    in — for a reader that lists what a store can hand over, which a sign-in never is."""
    placement = await placement_for_deployment(deployment_id)
    environment = placement.environment
    pairs = await credentials_in_scope(project)
    declared = declare(pairs)
    (vault_enabled, vault_names), deployments = await asyncio.gather(asyncio.to_thread(_vault_names), known_deployments())

    # The pairs' own project scope when it declares anything: its declared env files are then read once.
    own = next((s for _, s in pairs if s.project_id), None) or (project_scope(project) if project is not None else None)
    scopes = [user_scope()] + ([own] if own is not None else [])
    files = await asyncio.gather(*(asyncio.to_thread(_file_status, s, environment) for s in scopes))
    env_keys = {s.key: keys for s, (_, keys) in zip(scopes, files)}

    refs = {(str(spec.id), name): secret_store_ref(spec, scope, name, placement) for spec, scope in pairs for name in spec.stored_var_names()}
    remote = await _remote_names([ref for ref in refs.values() if ref.type not in LOCAL_STORE_TYPES])

    grants = await oauth_states([spec for spec, _ in pairs])
    rows: list["CredentialStatusRowSpec | _Draft"] = []
    for spec, scope in pairs:
        common = dict(
            typeid=str(spec.typeid), name=str(spec.name or ""), title=spec.title or str(spec.name or ""),
            description=spec.description or "", needed_for=spec.needed_for,
            justification=spec.justification, icon_name=spec.icon_name or "", help_url=spec.help_url or "",
            scope=scope.scope, project_id=scope.project_id, environment=environment,
            setup_skipped=spec.setup_skipped, asset_ref=str(spec.asset_ref or ""),
        )
        if spec.is_oauth:
            state, missing_scopes = grants.get(_grant_key(spec.provider, spec.scopes), ("missing", []))
            rows.append(CredentialStatusRowSpec(
                **common, value_store="connection", kind="oauth", provider=str(spec.provider or ""),
                scopes=list(spec.scopes or []), missing_scopes=missing_scopes, state=state,
            ))
            continue
        keys = env_keys.get(scope.key, set())
        var_rows: list[CredentialVarStatusSpec] = []
        required = set(placement.required(spec))
        stores: set[str] = set()
        for env_var, var in (spec.vars or {}).items():
            shown = dict(env_var=env_var, label=var.label, hint=var.hint, help_url=var.help_url,
                         required=_requirement(var, env_var in required), kind=var.kind, way=var.way)
            if var.is_cli:
                # Not signed in until its check says so, below — once the stored values are known.
                var_rows.append(CredentialVarStatusSpec(
                    **shown, secret=False, store="cli", warning="missing",
                    login=var.login_command, login_spec=var.login, check_spec=var.check,
                ))
                continue
            if var.is_oauth:
                # A way that is a sign-in through Flowpad: held when the provider's grant covers its scopes.
                held = grants.get(_grant_key(var.provider, var.scopes), ("missing", []))[0] == "connected"
                var_rows.append(CredentialVarStatusSpec(
                    **shown, secret=False, store="connection", present=held, warning=None if held else "missing",
                    provider=var.provider, scopes=list(var.scopes),
                ))
                continue
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
            var_rows.append(CredentialVarStatusSpec(
                **shown, placeholder=var.placeholder, pattern=var.pattern, secret=var.secret, store=store,
                present=present, found_in=found_in, warning=warning, shadowed_by=shadowed_by,
            ))
        rows.append(_Draft(spec, var_rows, required, dict(
            **common,
            setup_wiki=getattr(spec, "setup_wiki", "") or "",
            setup=getattr(spec, "setup", "") or "",
            setup_timeout_seconds=getattr(spec, "setup_timeout_seconds", None),
            value_store=next(iter(stores)) if len(stores) == 1 else "mixed",
            lm_provider=spec.lm_provider or "",
            setup_choice=spec.chosen,
            ways=dict(spec.ways or {}),
        )))

    # A sign-in lives on this computer: it is asked only for the deployment that IS this computer, and a
    # ONE_OF one only while no stored member already settles its group. Each check is a process, so they
    # run together, after every store has answered.
    drafts = [row for row in rows if isinstance(row, _Draft)]
    if sign_ins and (not deployment_id or any(str(d.id) == deployment_id and d.is_this_computer for d in deployments)):
        asked = [
            (draft, i) for draft in drafts
            for i, v in enumerate(draft.vars)
            if v.kind is CredentialVarKind.CLI and not (v.is_one_of and any(o.is_one_of and o.present for o in draft.vars))
        ]
        answers = await asyncio.gather(*(_signed_in(draft.spec.vars[draft.vars[i].env_var]) for draft, i in asked))
        for (draft, i), signed_in in zip(asked, answers):
            if signed_in:
                draft.vars[i] = draft.vars[i].model_copy(update={"present": True, "warning": None})
    rows = [row.settle() if isinstance(row, _Draft) else row for row in rows]

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
        files=[head for head, _ in files],
    )

