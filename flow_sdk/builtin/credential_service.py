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
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

from pydantic import ValidationError

from flow_sdk.builtin.credential_store import (
    CredentialScope,
    VaultNotEnabled,
    forget_values,
    project_scope,
    scope_of,
    user_scope,
    write_value,
)
from flow_sdk.schema.data_spec.credential_contract import CREDENTIAL_SCOPES, SCOPE_PROJECT, SCOPE_USER

if TYPE_CHECKING:
    from flow_sdk.builtin.credential_spec import CredentialSpec
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

_MANIFEST_FIELDS = (
    "title", "description", "icon_name", "help_url", "setup_wiki", "value_store", "lm_provider", "vars",
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


async def get_credential(typeid_or_id: str) -> Optional["CredentialSpec"]:
    from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415
    from flow_sdk.builtin.credential_spec import CredentialSpec  # noqa: PLC0415
    from flow_sdk.fs_store.type_id import TypeId  # noqa: PLC0415

    raw = str(typeid_or_id or "").strip()
    if not raw:
        return None
    if is_valid_uuid(raw):
        return await CredentialSpec.get_by_id(raw)
    try:
        return await CredentialSpec.get_by_id(TypeId(raw).id)
    except ValueError:
        return None


async def _owned_credential(typeid: str) -> tuple["CredentialSpec", CredentialScope, Optional["Project"]]:
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


def _write_values(spec: "CredentialSpec", scope: CredentialScope, values: dict[str, Any]) -> None:
    from flow_sdk.builtin.env_local_store import EnvLocalNotWritable  # noqa: PLC0415

    unknown = sorted(set(values) - set(spec.vars or {}))
    if unknown:
        raise CredentialError(f"{', '.join(unknown)} is not a variable of this credential")
    try:
        for env_var, value in values.items():
            if value is not None and str(value) != "":
                write_value(spec, scope, env_var, str(value))
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
) -> "CredentialSpec":
    """Create a credential in a scope, or update one; then write any values."""
    from flow_sdk.assets.creation import destination_in  # noqa: PLC0415
    from flow_sdk.builtin.asset_placement import resolve_default_harness, resolve_destination  # noqa: PLC0415
    from flow_sdk.builtin.credential_spec import CredentialSpec  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_manifest_spec import (  # noqa: PLC0415
        CURRENT_SCHEMA,
        CredentialManifestSpec,
    )
    from flow_sdk.schema.types import EntityType  # noqa: PLC0415

    manifest_in = dict(manifest or {})
    existing = None
    if typeid:
        existing, target_scope, project = await _owned_credential(typeid)
        manifest_in["name"] = existing.name
    else:
        target_scope, project = await _new_scope(str(scope or "").strip(), project_id)

    try:
        parsed = CredentialManifestSpec.model_validate({**manifest_in, "schema": CURRENT_SCHEMA})
    except ValidationError as e:
        raise CredentialError("; ".join(str(err["msg"]).removeprefix("Value error, ") for err in e.errors())) from e
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
        spec = CredentialSpec(name=parsed.name, manifest_schema=CURRENT_SCHEMA, **fields)
        family = resolve_destination(
            EntityType.CREDENTIAL_SPEC,
            target_scope.scope,
            default_worker=await resolve_default_harness(),
            project_mount=target_scope.root if target_scope.scope == SCOPE_PROJECT else None,
        )
        if family is None:
            raise CredentialError("credentials cannot be created in this scope")
        folder = destination_in(family, SchemaRegistry.get(EntityType.CREDENTIAL_SPEC), parsed.name)
        if folder.exists():
            raise CredentialError(f"a credential named {parsed.name!r} already exists in this scope")
        spec.asset_ref = str(folder)
        spec.scope = target_scope.scope
        spec.project_id = target_scope.project_id
        spec.parent_type_id = str(project.typeid) if project is not None else None

    _write_values(spec, target_scope, dict(values or {}))
    await spec.save()
    return spec


async def set_credential_values(typeid: str, values: dict[str, Any]) -> "CredentialSpec":
    """Set or rotate values. Empty values are skipped, never cleared."""
    spec, target_scope, _ = await _owned_credential(typeid)
    _write_values(spec, target_scope, dict(values or {}))
    return spec


async def delete_credential(typeid: str) -> dict[str, list[str]]:
    """Remove a credential: its folder, and the vault values it owns.

    ``.env.local`` lines are the user's and are always kept.
    """
    from flow_sdk.assets.asset import Asset  # noqa: PLC0415

    spec, target_scope, _ = await _owned_credential(typeid)
    deleted, kept = await forget_values(spec, target_scope)
    if spec.asset_ref and Path(spec.asset_ref).is_dir():
        Asset.from_path(spec.asset_ref).remove()
    await spec.delete()
    return {"deleted": deleted, "kept": kept}
