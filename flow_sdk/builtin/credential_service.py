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
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from pydantic import ValidationError

from flow_sdk.builtin.credential_store import (
    CredentialScope,
    forget_values,
    project_scope,
    scope_of,
    user_scope,
    write_value,
)
from flow_sdk.schema.data_spec.credential_contract import (
    CREDENTIAL_SCOPES,
    DEFAULT_ENVIRONMENT,
    SCOPE_PROJECT,
    SCOPE_USER,
    normalize_environment,
)
from flow_sdk.secrets import VaultNotEnabled

if TYPE_CHECKING:
    from flow_sdk.builtin.secret_pack import SecretPack
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

_MANIFEST_FIELDS = (
    "title", "description", "icon_name", "help_url", "setup_wiki", "setup", "value_store", "lm_provider", "vars",
    "environments",
)


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


async def get_credential(typeid_or_id: str) -> Optional["SecretPack"]:
    from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415
    from flow_sdk.builtin.secret_pack import SecretPack  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    raw = str(typeid_or_id or "").strip()
    if not raw:
        return None
    if is_valid_uuid(raw):
        return await SecretPack.get_by_id(raw)
    try:
        return await SecretPack.get_by_id(TypeId(raw).id)
    except ValueError:
        return None


async def _owned_credential(typeid: str) -> tuple["SecretPack", CredentialScope, Optional["Project"]]:
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


def _environment(environment: Optional[str]) -> str:
    try:
        return normalize_environment(environment)
    except ValueError as e:
        raise CredentialError(str(e)) from e


async def _write_values(
    spec: "SecretPack", scope: CredentialScope, values: dict[str, Any], environment: str = DEFAULT_ENVIRONMENT
) -> None:
    from flow_sdk.builtin.env_local_store import EnvLocalNotWritable  # noqa: PLC0415

    unknown = sorted(set(values) - set(spec.vars or {}))
    if unknown:
        raise CredentialError(f"{', '.join(unknown)} is not a variable of this credential")
    if spec.lm_provider and environment != DEFAULT_ENVIRONMENT and any(values.values()):
        raise CredentialError("an LLM provider key has no per-environment value; deployments are hub-funded")
    for env_var, value in values.items():
        pattern = spec.vars[env_var].pattern
        # ``search``, as the form's ``RegExp.test`` does: a pattern that means the whole value anchors itself.
        if pattern and value not in (None, "") and not re.search(pattern, str(value)):
            raise CredentialError(f"{env_var} does not look right (expected {pattern})", code="pattern")
    try:
        for env_var, value in values.items():
            if value is not None and str(value) != "":
                await write_value(spec, scope, env_var, str(value), environment)
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
    environment: Optional[str] = None,
) -> "SecretPack":
    """Create a credential in a scope, or update one; then write any values into ``environment``."""
    from flow_sdk.assets.creation import destination_in  # noqa: PLC0415
    from flow_sdk.builtin.asset_placement import resolve_default_harness, resolve_destination  # noqa: PLC0415
    from flow_sdk.builtin.secret_pack import SecretPack  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_spec import (  # noqa: PLC0415
        CURRENT_SCHEMA,
        CredentialSpec,
    )
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    environment = _environment(environment)
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
        spec = SecretPack(name=parsed.name, manifest_schema=CURRENT_SCHEMA, **fields)
        family = resolve_destination(
            EntityType.SECRET_PACK,
            target_scope.scope,
            default_worker=await resolve_default_harness(),
            project_mount=target_scope.root if target_scope.scope == SCOPE_PROJECT else None,
        )
        if family is None:
            raise CredentialError("credentials cannot be created in this scope")
        folder = destination_in(family, SchemaRegistry.get(EntityType.SECRET_PACK), parsed.name)
        if folder.exists():
            raise CredentialError(f"a credential named {parsed.name!r} already exists in this scope", code="exists")
        spec.asset_ref = str(folder)
        spec.scope = target_scope.scope
        spec.project_id = target_scope.project_id
        spec.parent_type_id = str(project.typeid) if project is not None else None

    await _write_values(spec, target_scope, dict(values or {}), environment)
    await spec.save()
    return spec


async def set_credential_values(
    typeid: str, values: dict[str, Any], environment: Optional[str] = None
) -> "SecretPack":
    """Set or rotate ``environment``'s values. Empty values are skipped, never cleared."""
    environment = _environment(environment)
    spec, target_scope, _ = await _owned_credential(typeid)
    await _write_values(spec, target_scope, dict(values or {}), environment)
    return spec


async def shipped_templates() -> list["SecretPack"]:
    """The catalogue: every credential Flowpad ships as a template, by name."""
    from flow_sdk.builtin.secret_pack import SecretPack  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import SCOPE_SYSTEM  # noqa: PLC0415

    match = ExpressionNode(op=QueryOp.EQ, operands=["scope", SCOPE_SYSTEM])
    return sorted(await SecretPack.get_all(QueryFilter(match=match)), key=lambda spec: str(spec.name))


async def template_named(name: str) -> Optional["SecretPack"]:
    """The shipped catalogue entry named ``name``, or ``None``."""
    return next((spec for spec in await shipped_templates() if spec.name == name), None)


async def credential_named(name: str, project: Optional["Project"], *, declare: bool = False) -> Optional["SecretPack"]:
    """The credential ``name`` as ``project`` sees it (its own, else the user's).

    With ``declare``, a name neither scope has is added from the shipped template of that name —
    into the project, or the user scope for a provider key — with no values.
    """
    from flow_sdk.builtin.secret_pack import CredentialAmbiguous, CredentialNotFound, SecretPack  # noqa: PLC0415

    try:
        return await SecretPack.get(name, project)
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
    name: str, values: dict[str, Any], *, project_id: Optional[str] = None, environment: Optional[str] = None
) -> "SecretPack":
    """``flow credentials set``: fill ``name``'s values, declaring it from its template if needed."""
    project = await get_project(project_id)
    if project_id and project is None:
        raise CredentialError("project not found")
    if not any(str(v or "") for v in (values or {}).values()):
        raise CredentialError("no value given")
    spec = await credential_named(name, project, declare=True)
    return await set_credential_values(str(spec.typeid), values, environment)


async def delete_credential(typeid: str) -> dict[str, list[str]]:
    """Remove a credential: its folder, and the vault values it owns in every environment.

    Env file lines are the user's and are always kept.
    """
    from flow_sdk.assets.asset import Asset  # noqa: PLC0415
    from flow_sdk.builtin.credential_resolver import known_environments  # noqa: PLC0415

    spec, target_scope, _ = await _owned_credential(typeid)
    environments = [*await known_environments(), *(spec.environments or {})]
    deleted, kept = await forget_values(spec, target_scope, environments)
    if spec.asset_ref and Path(spec.asset_ref).is_dir():
        Asset.from_path(spec.asset_ref).remove()
    await spec.delete()
    return {"deleted": deleted, "kept": kept}
