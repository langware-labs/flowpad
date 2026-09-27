"""Declare, fill and remove credentials — the operations behind every entry point.

The HTTP action (``app/actions/credentials_action.py``) is a thin wrapper; tests
and in-process callers use these directly.

``save_credential`` is the one write: a custom API key, a catalogue template
added to a scope, detected ``.env.local`` keys packed into one credential (no
values), and the quick-create "Secret" tile all go through it. Values are
written BEFORE the credential folder is created, so a refused value (a
committable ``.env.local``, a disabled vault) never leaves an empty declaration
behind. No function here returns a value.
"""
from __future__ import annotations

import logging
import re
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from pydantic import ValidationError

from flow_sdk.builtin.credential_store import (
    CredentialScope,
    Placement,
    forget_values,
    project_scope,
    scope_of,
    secret_store_ref,
    user_scope,
    write_value,
)
from flow_sdk.schema.data_spec.credential_contract import (
    CREDENTIAL_SCOPES,
    DEFAULT_ENVIRONMENT,
    SCOPE_PROJECT,
    SCOPE_USER,
)
from flow_sdk.schema.data_spec.credential_status_spec import CredentialDeletedSpec
from flow_sdk.schema.data_spec.deployment_secrets_spec import store_ref
from flow_sdk.secrets import SecretStore, VaultNotEnabled

if TYPE_CHECKING:
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

_MANIFEST_FIELDS = ("title", "description", "icon_name", "help_url", "setup_wiki", "setup", "lm_provider", "vars")


class CredentialError(ValueError):
    """A refused credential operation. ``code`` names a fixable condition."""

    def __init__(self, message: str, *, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.code = code


async def get_project(project_id: Optional[str]) -> Optional["Project"]:
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    if not project_id:
        return None
    return await Project.get_by_id(str(project_id))


async def get_credential(typeid_or_id: str) -> Optional["Credential"]:
    from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    raw = str(typeid_or_id or "").strip()
    if not raw:
        return None
    if is_valid_uuid(raw):
        return await Credential.get_by_id(raw)
    try:
        return await Credential.get_by_id(TypeId(raw).id)
    except ValueError:
        return None


async def _owned_credential(typeid: str) -> tuple["Credential", CredentialScope, Optional["Project"]]:
    """A user or project credential with a live scope — never a template."""
    spec = await get_credential(typeid)
    if spec is None:
        raise CredentialError("credential not found")
    if spec.is_template:
        raise CredentialError("a catalogue template cannot be changed; add it to a scope instead")
    scope, project = await scope_of(spec)
    if scope is None:
        raise CredentialError("this credential has no scope on this machine")
    return spec, scope, project


async def _deployment(deployment_id: Optional[str]) -> "Deployment":
    """The deployment values are read and written at: ``deployment_id``'s, else this computer."""
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415

    try:
        return await Deployment.resolve(deployment_id or "")
    except LookupError as e:
        raise CredentialError(str(e)) from e


async def _write_values(spec: "Credential", scope: CredentialScope, values: dict[str, Any], placement: Placement) -> None:
    from flow_sdk.builtin.env_local_store import EnvLocalNotWritable  # noqa: PLC0415

    unknown = sorted(set(values) - set(spec.vars or {}))
    if unknown:
        raise CredentialError(f"{', '.join(unknown)} is not a variable of this credential")
    if spec.lm_provider and placement.environment != DEFAULT_ENVIRONMENT and any(values.values()):
        raise CredentialError("an LLM provider key has no per-environment value; deployments are hub-funded")
    for env_var, value in values.items():
        pattern = spec.vars[env_var].pattern
        # ``search``, as the form's ``RegExp.test`` does: a pattern that means the whole value anchors itself.
        if pattern and value not in (None, "") and not re.search(pattern, str(value)):
            raise CredentialError(f"{env_var} does not look right (expected {pattern})", code="pattern")
    try:
        for env_var, value in values.items():
            if value is not None and str(value) != "":
                await write_value(spec, scope, env_var, str(value), placement)
    except (EnvLocalNotWritable, VaultNotEnabled) as e:
        raise CredentialError(str(e), code=e.code) from e


async def _clash_in_scope(
    scope: CredentialScope, project: Optional["Project"], var_names: list[str], *, ignore_id: Optional[str]
) -> Optional[str]:
    from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415

    for other, other_scope in await credentials_in_scope(project):
        if other_scope.key != scope.key or (ignore_id and str(other.id) == ignore_id):
            continue
        clash = sorted(set(other.var_names()) & set(var_names))
        if clash:
            return f"{', '.join(clash)} is already declared by {other.title or other.name} in this scope"
    return None


async def _new_scope(scope_name: str, project_id: Optional[str]) -> tuple[CredentialScope, Optional["Project"]]:
    if scope_name not in CREDENTIAL_SCOPES:
        raise CredentialError(f"scope must be one of {list(CREDENTIAL_SCOPES)}")
    if scope_name == SCOPE_PROJECT:
        project = await get_project(project_id)
        if project is None:
            raise CredentialError("project not found")
        scope = project_scope(project)
    else:
        project, scope = None, user_scope()
    if scope.root is None or not Path(scope.root).is_dir():
        raise CredentialError("this scope has no folder on this machine", code="no-project-dir")
    return scope, project


async def save_credential(
    *,
    manifest: dict[str, Any],
    scope: Optional[str] = None,
    project_id: Optional[str] = None,
    typeid: Optional[str] = None,
    values: Optional[dict[str, Any]] = None,
    deployment_id: Optional[str] = None,
    store: Optional[str] = None,
) -> "Credential":
    """Create a credential in a scope, or update one; then write any values where ``deployment_id``
    (default: this computer) keeps them. ``store`` (``env`` / ``vault``) first makes that deployment
    keep this credential's variables there — the choice a form offers, never part of the credential."""
    from flow_sdk.assets.creation import destination_in  # noqa: PLC0415
    from flow_sdk.builtin.asset_placement import resolve_default_harness, resolve_destination  # noqa: PLC0415
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_spec import (  # noqa: PLC0415
        CURRENT_SCHEMA,
        CredentialSpec,
    )
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    deployment = await _deployment(deployment_id)
    manifest_in = dict(manifest or {})
    existing = None
    if typeid:
        existing, target_scope, project = await _owned_credential(typeid)
        manifest_in["name"] = existing.name
    else:
        target_scope, project = await _new_scope(str(scope or "").strip(), project_id)

    try:
        parsed = CredentialSpec.model_validate({**manifest_in, "schema": CURRENT_SCHEMA})
    except ValidationError as e:
        raise CredentialError("; ".join(str(err["msg"]).removeprefix("Value error, ") for err in e.errors())) from e
    if not parsed.setup.strip():
        raise CredentialError(
            "a credential needs setup instructions: how to obtain its values and store them "
            f"(piped as `VAR=VALUE` lines into `flow credentials set {parsed.name} --stdin`)"
        )
    if parsed.lm_provider and target_scope.scope != SCOPE_USER:
        raise CredentialError("an LLM provider key funds every project, so it can only be added for the user")

    clash = await _clash_in_scope(target_scope, project, list(parsed.vars), ignore_id=str(existing.id) if existing else None)
    if clash:
        raise CredentialError(clash)

    fields = {name: getattr(parsed, name) for name in _MANIFEST_FIELDS}
    if existing is not None:
        spec = existing
        for name, value in fields.items():
            setattr(spec, name, value)
    else:
        spec = Credential(name=parsed.name, manifest_schema=CURRENT_SCHEMA, **fields)
        family = resolve_destination(
            EntityType.CREDENTIAL,
            target_scope.scope,
            default_worker=await resolve_default_harness(),
            project_mount=target_scope.root if target_scope.scope == SCOPE_PROJECT else None,
        )
        if family is None:
            raise CredentialError("credentials cannot be created in this scope")
        folder = destination_in(family, SchemaRegistry.get(EntityType.CREDENTIAL), parsed.name)
        if folder.exists():
            raise CredentialError(f"a credential named {parsed.name!r} already exists in this scope", code="exists")
        spec.asset_ref = str(folder)
        spec.scope = target_scope.scope
        spec.project_id = target_scope.project_id
        spec.parent_type_id = str(project.typeid) if project is not None else None

    if store and not parsed.lm_provider:
        try:
            ref = store_ref(str(store))
        except ValueError as e:
            raise CredentialError(str(e)) from e
        await deployment.keep_in(list(parsed.vars), ref)
    await _write_values(spec, target_scope, dict(values or {}), await Placement.of(deployment))
    await spec.save()
    return spec


async def set_credential_values(
    typeid: str, values: dict[str, Any], deployment_id: Optional[str] = None
) -> "Credential":
    """Set or rotate the values ``deployment_id`` (default: this computer) reads. Empty values are
    skipped, never cleared."""
    placement = await Placement.of(await _deployment(deployment_id))
    spec, target_scope, _ = await _owned_credential(typeid)
    await _write_values(spec, target_scope, dict(values or {}), placement)
    return spec


async def shipped_templates() -> list["Credential"]:
    """The catalogue: every credential Flowpad ships as a template, by name."""
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import SCOPE_SYSTEM  # noqa: PLC0415

    match = ExpressionNode(op=QueryOp.EQ, operands=["scope", SCOPE_SYSTEM])
    return sorted(await Credential.get_all(QueryFilter(match=match)), key=lambda spec: str(spec.name))


async def template_named(name: str) -> Optional["Credential"]:
    """The shipped catalogue entry named ``name``, or ``None``."""
    return next((spec for spec in await shipped_templates() if spec.name == name), None)


async def credential_named(name: str, project: Optional["Project"], *, declare: bool = False) -> Optional["Credential"]:
    """The credential ``name`` as ``project`` sees it (its own, else the user's).

    With ``declare``, a name neither scope has is added from the shipped template of that name —
    into the project, or the user scope for a provider key — with no values.
    """
    from flow_sdk.builtin.credential import Credential, CredentialAmbiguous, CredentialNotFound  # noqa: PLC0415

    try:
        return await Credential.get(name, project)
    except CredentialAmbiguous as e:
        raise CredentialError(str(e)) from e
    except CredentialNotFound:
        if not declare:
            return None
    template = await template_named(name)
    if template is None:
        raise CredentialError(f"no credential or template named {name!r}")
    scope = SCOPE_USER if template.lm_provider or project is None else SCOPE_PROJECT
    return await save_credential(
        manifest={"name": name, **{field: getattr(template, field) for field in _MANIFEST_FIELDS}},
        scope=scope,
        project_id=str(project.id) if project is not None else None,
    )


async def set_credential_by_name(
    name: str, values: dict[str, Any], *, project_id: Optional[str] = None, deployment_id: Optional[str] = None
) -> "Credential":
    """``flow credentials set``: fill ``name``'s values, declaring it from its template if needed."""
    project = await get_project(project_id)
    if project_id and project is None:
        raise CredentialError("project not found")
    if not any(str(v or "") for v in (values or {}).values()):
        raise CredentialError("no value given")
    spec = await credential_named(name, project, declare=True)
    return await set_credential_values(str(spec.typeid), values, deployment_id)


async def declare_credential(manifest: dict[str, Any], *, project_id: str) -> "Credential":
    """``flow credentials declare``: save ``manifest`` in the project — updating the project's own
    credential of that name in place, so declaring twice is declaring once. (``save_credential``
    stays create-or-refuse: a dialog creating a second ``telegram`` must not overwrite the first.)"""
    project = await get_project(project_id)
    if project is None:
        raise CredentialError("project not found")
    own = await credential_named(str(manifest.get("name") or ""), project)
    if own is not None and own.scope == SCOPE_PROJECT:
        return await save_credential(manifest=manifest, typeid=str(own.typeid))
    return await save_credential(manifest=manifest, scope=SCOPE_PROJECT, project_id=project_id)


async def delete_credential(typeid: str) -> CredentialDeletedSpec:
    """Remove a credential and every value it owns, in every store a known deployment keeps it in.

    Vault entries and ``.env*`` lines alike (a scope never lets two credentials declare one
    variable, so every value found is this credential's). The credential itself is removed only
    when no store still holds one of its values — otherwise it stays, the handle to retry, and the report
    names each store that kept something or could not be reached.
    """
    from flow_sdk.assets.asset import Asset  # noqa: PLC0415
    from flow_sdk.builtin.credential_resolver import known_placements  # noqa: PLC0415

    spec, target_scope, _ = await _owned_credential(typeid)
    stores = await forget_values(spec, target_scope, await known_placements())
    kept = {name for store in stores for name in store.kept}
    deleted = {name for store in stores for name in store.deleted} - kept
    names = spec.var_names()
    removed = not kept
    if removed:
        if spec.asset_ref and Path(spec.asset_ref).is_dir():
            Asset.from_path(spec.asset_ref).remove()
        await spec.delete()
    return CredentialDeletedSpec(
        removed=removed,
        deleted=[n for n in names if n in deleted],
        kept=[n for n in names if n in kept],
        stores=stores,
    )


# ── on a deployment's machine: the values the hub places ──────────────────────
#
# The hub places a deployment's stored values on its machine when it starts, and wipes them before a
# pause (hub ``app/services/deployment_secrets.py``). Values arrive in a file the hub writes into the drop
# folder handed out here — never in a request body, which the hub's transport passes on a command line —
# and are written exactly where this machine's own lookup reads them (``write_value`` at the
# deployment's placement), so every process here sees them like any local value.


def drop_folder() -> Path:
    """The private (0700) folder the hub drops a values file into."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    folder = Path(get_instance_settings().instance_dir) / "credential-drop"
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder.chmod(0o700)
    return folder


def _take_dropped(file: str) -> dict[str, str]:
    """Read and delete a dropped values file; only a file inside the drop folder is ever read."""
    import json  # noqa: PLC0415

    path = Path(file).resolve()
    if path.parent != drop_folder().resolve() or not path.is_file():
        raise CredentialError("not a dropped values file")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    finally:
        path.unlink(missing_ok=True)
    values = raw.get("values") if isinstance(raw, dict) else None
    if not isinstance(values, dict):
        raise CredentialError("the dropped file holds no values")
    return {str(k): str(v) for k, v in values.items() if v}


async def declare_vars(
    credential: str, env_vars: list[str], project: Optional["Project"] = None, *, setup: str = ""
) -> "Credential":
    """``credential`` as ``project`` sees it (default: the user scope), declaring ``env_vars``: its own
    declaration, else its shipped template (with the template's labels, patterns and provider), else a
    bare one (``setup`` says where it came from); an existing declaration keeps every field and only
    gains the variables it lacks."""
    try:
        existing = await credential_named(credential, project, declare=True)
    except CredentialError:  # neither declared nor a template by that name
        existing = None
    new = [v for v in env_vars if existing is None or v not in existing.var_names()]
    if existing is None:
        manifest = {"name": credential, "vars": {v: {} for v in new}, "setup": setup or "Declared for its values."}
        if project is not None:
            return await save_credential(manifest=manifest, scope=SCOPE_PROJECT, project_id=str(project.id))
        return await save_credential(manifest=manifest, scope=SCOPE_USER)
    if not new:
        return existing
    manifest = {"name": credential, **{field: getattr(existing, field) for field in _MANIFEST_FIELDS}}
    manifest["vars"] = {**(existing.vars or {}), **{v: {} for v in new}}
    return await save_credential(manifest=manifest, typeid=str(existing.typeid))


async def _declaring(names: list[str], project: Optional["Project"], deployment: "Deployment") -> dict:
    """``{VAR: DeclaredVar}`` for ``names``, declaring on this machine any name nothing here declares —
    a user-scope credential on the laptop does not travel with the repo. Grouped by the credential the
    agent's requirements name for it; the rest in one ``deployment-secrets`` credential."""
    from flow_sdk.builtin.credential_resolver import declared_vars  # noqa: PLC0415

    declared = await declared_vars(project)
    missing = [n for n in names if n not in declared]
    if not missing:
        return declared
    agent = await deployment.element()
    owner = {v: r.name for r in (getattr(agent, "requirements", None) or []) if r.kind == "credential" for v in r.vars}
    groups: dict[str, list[str]] = {}
    for name in missing:
        groups.setdefault(owner.get(name, "deployment-secrets"), []).append(name)
    for credential, env_vars in groups.items():
        await declare_vars(credential, env_vars, setup="Placed on this machine by the hub for its deployment.")
    return await declared_vars(project)


async def _on_this_machine(deployment_id: str, environment: str) -> tuple["Deployment", Placement]:
    """Where a deployment's machine reads its values: the row this machine keeps for ``deployment_id``
    (``adopt_placement`` re-keys the agent's; ``expose-endpoints`` keys a serving one), else this
    machine's own — the machine IS that deployment, and the hub places before, or without, a successful
    adopt. The environment is the one the hub sends, never the row's (a serving row carries the
    instance default); it becomes this instance's default, so the agent and every terminal read it."""
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.instance_settings.environment import set_default_environment  # noqa: PLC0415

    if environment:
        environment = set_default_environment(environment)
    row = (await Deployment.get_by_id(deployment_id) if deployment_id else None) or await Deployment.this_computer()
    placement = await Placement.of(row)
    return row, replace(placement, environment=environment) if environment else placement


async def place_values(deployment_id: str, project_id: str, file: str, environment: str = "") -> dict[str, Any]:
    """Write the values the hub dropped where this machine reads them for ``deployment_id``:
    ``{placed, failed}`` names."""

    values = _take_dropped(file)
    deployment, placement = await _on_this_machine(deployment_id, environment)
    project = await get_project(project_id) if project_id else None
    declared = await _declaring(list(values), project, deployment)
    failed: dict[str, str] = {name: "not declared here" for name in values if name not in declared}
    # One write per store: an env file is rewritten, a vault re-encrypted, once — not once per value.
    stores: dict = {}
    for name, value in values.items():
        if name in declared:
            ref = secret_store_ref(declared[name].spec, declared[name].scope, name, placement)
            stores.setdefault(ref.key, (ref, {}))[1][name] = value
    placed: list[str] = []
    for ref, batch in stores.values():
        try:
            await SecretStore.from_ref(ref).save(batch, description="placed by the hub for its deployment")
            placed += batch
        except Exception as e:  # noqa: BLE001 — reported per name, names only
            failed.update({name: type(e).__name__ for name in batch})
    return {"placed": sorted(placed), "failed": failed}


async def unplace_values(deployment_id: str, project_id: str, names: list[str], environment: str = "") -> dict[str, Any]:
    """Remove ``names`` from wherever this machine reads them for ``deployment_id``: ``{removed}``."""
    from flow_sdk.builtin.credential_resolver import declared_vars  # noqa: PLC0415
    from flow_sdk.builtin.credential_store import forget_in, secret_store_ref  # noqa: PLC0415

    _, placement = await _on_this_machine(deployment_id, environment)
    project = await get_project(project_id) if project_id else None
    declared = await declared_vars(project)
    refs = [secret_store_ref(declared[n].spec, declared[n].scope, n, placement) for n in names if n in declared]
    reports = await forget_in(refs, names)
    return {"removed": sorted({n for r in reports for n in r.deleted})}


# ── "use mine": this computer's values into a deployment's store ──────────────


async def use_mine(deployment_id: str, names: Optional[list[str]] = None) -> dict[str, Any]:
    """Copy this computer's values for ``names`` (default: what the deployment's agent needs and its
    store lacks) into the store ``deployment_id`` keeps them in — for a cloud deployment, the hub, which
    places them on its machine. A value is read and written here, never shown or logged:
    ``{copied, not_here, hub_funded}`` names. An LLM provider key is never copied: a deployment is
    hub-funded (the rule ``_write_values`` enforces). A protected deployment refuses: its values are
    entered directly.
    """
    from flow_sdk.builtin.credential_resolver import declared_vars, resolve_project_secrets  # noqa: PLC0415
    from flow_sdk.builtin.readiness import project_of, readiness  # noqa: PLC0415

    deployment = await _deployment(deployment_id)
    placement = await Placement.of(deployment)
    if placement.secrets.protected:
        raise CredentialError("a protected deployment's values are entered directly, never copied in", code="protected")
    agent = await deployment.element()
    project = await project_of(agent) if agent is not None else None
    if names is None:
        if agent is None:
            raise CredentialError("name the values to copy: this deployment runs no agent")
        ready = await readiness(agent, deployment)
        names = ready.value_names(missing_only=True)
    declared = await declared_vars(project)
    funded = sorted(n for n in names if n in declared and declared[n].spec.lm_provider)
    names = [n for n in names if n not in funded]
    mine = await resolve_project_secrets(project, only=names, placement=await Placement.of(None))
    stores: dict = {}
    for name, value in mine.items():
        ref = secret_store_ref(declared[name].spec, declared[name].scope, name, placement)
        stores.setdefault(ref.key, (ref, {}))[1][name] = value
    for ref, values in stores.values():
        await SecretStore.from_ref(ref).save(values, description="copied from the owner's computer")
    return {"copied": sorted(mine), "not_here": sorted(set(names) - set(mine)), "hub_funded": funded}
