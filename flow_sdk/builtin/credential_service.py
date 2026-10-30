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
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Mapping, Optional

from pydantic import ValidationError

from flow_sdk.builtin.credential import write_setup_choice
from flow_sdk.builtin.credential_files import credential_file, remove_credential_files, write_credential_file
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
    CredentialKind,
    CredentialVarKind,
)
from flow_sdk.schema.data_spec.credential_status_spec import CredentialDeletedSpec
from flow_sdk.schema.data_spec.deployment_secrets_spec import store_ref
from flow_sdk.secrets import SecretStore, VaultNotEnabled

if TYPE_CHECKING:
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.builtin.project import Project

logger = logging.getLogger(__name__)

_MANIFEST_FIELDS = (
    "title", "description", "needed_for", "justification", "icon_name", "help_url", "setup_wiki", "setup", "setup_timeout_seconds", "lm_provider",
    "kind", "provider", "scopes", "optional_scopes", "vars", "ways", "derived",
)


def _manifest_of(spec: "Credential") -> dict[str, Any]:
    """``spec`` as the manifest ``save_credential`` takes — what re-saving it would write."""
    return {"name": spec.name, **{field: getattr(spec, field) for field in _MANIFEST_FIELDS}}


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


async def _write_values(
    spec: "Credential", scope: CredentialScope, values: dict[str, Any], placement: Placement, *, literal: bool = False
) -> None:
    """``literal``: values that came from someone else (a secured transfer) are written as given — a file
    variable's ``@path`` shortcut, which reads a file on THIS machine, never applies to them."""
    from flow_sdk.builtin.env_local_store import EnvLocalNotWritable  # noqa: PLC0415

    unknown = sorted(set(values) - set(spec.vars or {}))
    if unknown:
        raise CredentialError(f"{', '.join(unknown)} is not a variable of this credential")
    signed_in = sorted(name for name, v in values.items() if not spec.vars[name].holds_value and v not in (None, ""))
    if signed_in:
        raise CredentialError(f"{', '.join(signed_in)} is a sign-in, not a value: nothing is stored for it")
    if spec.lm_provider and placement.environment != DEFAULT_ENVIRONMENT and any(values.values()):
        raise CredentialError("an LLM provider key has no per-environment value; deployments are hub-funded")
    # A file var's content, read now: the pattern is checked against it, not against an ``@path``.
    values = {
        name: _file_content(str(v)) if spec.vars[name].kind is CredentialVarKind.FILE and v not in (None, "") and not literal else v
        for name, v in values.items()
    }
    for env_var, value in values.items():
        pattern = spec.vars[env_var].pattern
        # ``search``, as the form's ``RegExp.test`` does: a pattern that means the whole value anchors itself.
        if pattern and value not in (None, "") and not re.search(pattern, str(value)):
            raise CredentialError(f"{env_var} does not look right (expected {pattern})", code="pattern")
    try:
        for env_var, value in values.items():
            if value is not None and str(value) != "":
                if spec.vars[env_var].kind is CredentialVarKind.FILE:
                    # The content is kept as a file; the variable holds its path.
                    path = credential_file(spec, scope, env_var, placement.environment)
                    write_credential_file(path, str(value))
                    value = str(path)
                await write_value(spec, scope, env_var, str(value), placement)
    except (EnvLocalNotWritable, VaultNotEnabled) as e:
        raise CredentialError(str(e), code=e.code) from e


def _file_content(value: str) -> str:
    """A ``file`` var's value as given: the content itself, or ``@<path>`` naming a file to read —
    how a ``VAR=VALUE`` line (``flow credentials set --stdin``) carries a key file."""
    if value.startswith("@") and "\n" not in value:
        source = Path(value[1:]).expanduser()
        if not source.is_file():
            raise CredentialError(f"no file at {source}", code="file")
        return source.read_text(encoding="utf-8")
    return value


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
    require_setup: bool = True,
    auto_declare: bool = False,
) -> "Credential":
    """Create a credential in a scope, or update one; then write any values where ``deployment_id``
    (default: this computer) keeps them. ``store`` (``env`` / ``vault``) first makes that deployment
    keep this credential's variables there — the choice a form offers, never part of the credential.
    ``require_setup=False`` is for a save that only re-files what already exists: ``setup`` is required
    of an author, not of a credential found on disk without it."""
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

    if auto_declare:
        manifest_in, existing = await _auto_declaration(manifest_in, target_scope, project)
        require_setup = False

    try:
        parsed = CredentialSpec.model_validate({**manifest_in, "schema": CURRENT_SCHEMA})
    except ValidationError as e:
        raise CredentialError("; ".join(str(err["msg"]).removeprefix("Value error, ") for err in e.errors())) from e
    # An oauth credential's "setup" is a person's consent click — there are no values to obtain by hand.
    if require_setup and parsed.kind is not CredentialKind.OAUTH and not parsed.setup.strip():
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


async def _auto_declaration(manifest: dict, scope: CredentialScope, project: Optional["Project"]):
    """Match exact variable names, never guess a provider from a prefix or a secret value."""
    from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415

    variables = dict(manifest.get("vars") or {})
    if len(variables) != 1:
        raise CredentialError("auto setup expects one variable at a time")
    key = next(iter(variables))
    name = str(manifest.get("name") or "").strip()
    owned = [spec for spec, location in await credentials_in_scope(project) if location.key == scope.key]
    matches = [spec for spec in owned if key in spec.vars]
    if name and matches and any(spec.name != name for spec in matches):
        raise CredentialError(f"{key} already belongs to {matches[0].name}")
    if not matches and name:
        matches = [spec for spec in owned if spec.name == name]
    if len(matches) > 1:
        raise CredentialError(f"More than one credential declares {key}; edit its credential directly")
    existing = matches[0] if matches else None
    template = None
    if existing is None:
        templates = await shipped_templates()
        matches = [spec for spec in templates if spec.name == name] if name else [
            spec for spec in templates if key in spec.vars
        ]
        if len(matches) > 1:
            raise CredentialError(f"More than one credential matches {key}; enter a credential name")
        template = matches[0] if matches else None
    target_name = name or (str(template.name) if template is not None else key.lower().replace("_", "-").strip("-"))
    if existing is None:
        existing = next((spec for spec in owned if spec.name == target_name), None)
    source = existing or template
    if source is not None and source.kind != CredentialKind.ENV:
        raise CredentialError("Choose a credential that stores environment variables")
    resolved = _manifest_of(source) if source is not None else {
        "name": target_name, "vars": {},
    }
    current = resolved["vars"].get(key)
    base = current.model_dump(mode="json") if current is not None else {}
    resolved["vars"] = {**resolved["vars"], key: {**base, **variables[key]}}
    return resolved, existing


async def set_credential_values(
    typeid: str, values: dict[str, Any], deployment_id: Optional[str] = None, *, literal: bool = False
) -> "Credential":
    """Set or rotate the values ``deployment_id`` (default: this computer) reads. Empty values are
    skipped, never cleared. ``literal``: see :func:`_write_values`."""
    placement = await Placement.of(await _deployment(deployment_id))
    spec, target_scope, _ = await _owned_credential(typeid)
    await _write_values(spec, target_scope, dict(values or {}), placement, literal=literal)
    return spec


async def shipped_templates() -> list["Credential"]:
    """The catalogue: every credential Flowpad ships as a template, by name."""
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import SCOPE_SYSTEM  # noqa: PLC0415

    match = ExpressionNode(op=QueryOp.EQ, operands=["scope", SCOPE_SYSTEM])
    return sorted(await Credential.get_all(QueryFilter(match=match)), key=lambda spec: str(spec.name))


async def credential_for_need(names: Iterable[str], project: Optional["Project"], *, pairs: Optional[list] = None,
                              templates: Optional[list["Credential"]] = None) -> dict[str, "Credential"]:
    """``{VAR: credential}`` — who answers each needed variable in ``project``: the credential a process there
    reads it from (``credential_resolver.declare``), else the shipped template that says how to ask for it. The
    one "who needs this" lookup: a template is how to ask, never a reason the need exists. ``pairs`` /
    ``templates``: already read by the caller (``credentials_in_scope`` / ``shipped_templates``)."""
    from flow_sdk.builtin.credential_resolver import credentials_in_scope, declare  # noqa: PLC0415

    wanted = set(names)
    declared = declare(pairs if pairs is not None else await credentials_in_scope(project))
    owner = {name: declared[name].spec for name in wanted if name in declared}
    for template in templates if templates is not None else await shipped_templates():
        for var in template.stored_var_names():
            if var in wanted:
                owner.setdefault(var, template)
    return owner


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
        manifest={**_manifest_of(template), "derived": scope == SCOPE_PROJECT},  # for a root's need, gone with it
        scope=scope,
        project_id=str(project.id) if project is not None else None,
    )


async def set_credential_by_name(
    name: str, values: dict[str, Any], *, project_id: Optional[str] = None, deployment_id: Optional[str] = None,
    choice: str = "",
) -> "Credential":
    """``flow credentials set``: fill ``name``'s values, declaring it from its template if needed. ``choice`` names
    the ONE_OF way set up here when it holds no value (a sign-in through Flowpad); a value given for exactly one
    way chooses that way by itself."""
    project = await get_project(project_id)
    if project_id and project is None:
        raise CredentialError("project not found")
    has_values = any(str(v or "") for v in (values or {}).values())
    if not has_values and not choice:
        raise CredentialError("no value given")
    spec = await credential_named(name, project, declare=True)
    stored = await set_credential_values(str(spec.typeid), values, deployment_id) if has_values else spec
    # The way the values were given for: every ONE_OF value given names its way — one way, and it is the choice.
    ways = sorted({way for var, value in (values or {}).items() if str(value or "") and (way := spec.way_of(var))})
    if way := choice or (ways[0] if len(ways) == 1 else ""):
        try:
            await write_setup_choice(spec, way)
        except ValueError as e:
            raise CredentialError(str(e)) from e
    await _reverify_waiting_sources(spec.name, project)
    return stored


async def _reverify_waiting_sources(name: str, project: Any) -> None:
    """The project's sources still in setup that read credential ``name`` check again now: setting the credential
    is what they waited on, and nothing else re-checks a source in setup (the poller runs active ones only)."""
    from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415

    for source in await DataSource.get_all({"status": SourceStatus.SETUP.value}):
        auth = source._auth()
        if getattr(auth, "credential", "") != name or (project is not None and str(source.project_id) != str(project.id)):
            continue
        try:
            await source.verify()
        except Exception:  # noqa: BLE001 — storing the value succeeded; a failed re-check leaves the source as it was
            logger.warning("credential %s: could not re-check source %s", name, source.id, exc_info=True)


def shipped_provider_title(provider: str) -> str:
    """A provider's display name from the registry this build ships, in-process; ``""`` when it ships none —
    the synchronous half of ``_provider_title``, for a caller that cannot await (a computed field)."""
    from flow_sdk.core.oauth.provider_registry import get_local_provider  # noqa: PLC0415

    known = get_local_provider(provider)
    return known.display_name if known is not None and known.display_name else ""


async def _provider_title(provider: str) -> str:
    """A provider's display name, as the Connections screen shows it; else its name.

    A provider this build ships answers from the registry, in-process. Only one the hub alone
    defines asks the connection service — which borrows a running backend or STARTS one, far
    too much for a title when the registry already knows it.
    """
    if known := shipped_provider_title(provider):
        return known
    try:
        from flow_sdk.core.connections.specs import resolve_connection_spec  # noqa: PLC0415

        spec = await resolve_connection_spec(provider)
        if spec is not None and spec.display_name:
            return spec.display_name
    except Exception:  # noqa: BLE001 — a title is cosmetic; the name serves
        pass
    return provider.title()


async def declare_oauth(project: "Project", provider: str, scopes: list[str]) -> tuple["Credential", bool]:
    """The project's oauth credential for ``provider``, covering at least ``scopes`` — declared from the shipped
    template (or, for a provider only the hub defines, from its catalogue row) when the project has none, and
    widened in place when a source needs more. Declaring what is already declared writes nothing.
    Returns ``(credential, changed)``."""
    from flow_sdk.builtin.credential_resolver import credentials_in_scope  # noqa: PLC0415

    provider = str(provider or "").strip().lower()
    wanted = [str(scope) for scope in scopes or []]
    # Found by what it IS — the project's oauth credential for this provider — whatever it is named.
    pairs = await credentials_in_scope(project)
    own = next((spec for spec, _ in pairs
                if spec.is_oauth and spec.scope == SCOPE_PROJECT and str(spec.provider or "").lower() == provider), None)
    if own is not None:
        merged = list(dict.fromkeys([*(own.scopes or []), *wanted]))
        if merged == list(own.scopes or []):
            return own, False
        return await declare_credential({**_manifest_of(own), "scopes": merged}, project_id=str(project.id),
                                        require_setup=False), True
    # A new one is named for its provider — unless an env credential (an API key named "google") has that name.
    taken = {str(spec.name) for spec, _ in pairs}
    name = provider if provider not in taken else f"{provider}-oauth"
    template = await template_named(provider)
    if template is not None and template.is_oauth:
        manifest = {**_manifest_of(template), "name": name,
                    "scopes": list(dict.fromkeys([*(template.scopes or []), *wanted]))}
    else:
        manifest = {"name": name, "title": await _provider_title(provider), "kind": CredentialKind.OAUTH.value,
                    "provider": provider, "scopes": wanted}
    manifest["derived"] = True  # a root's connection: needed while one acts through it
    return await declare_credential(manifest, project_id=str(project.id), require_setup=False), True


async def declare_credential(manifest: dict[str, Any], *, project_id: str, require_setup: bool = True) -> "Credential":
    """``flow credentials declare``: save ``manifest`` in the project — updating the project's own
    credential of that name in place, so declaring twice is declaring once. (``save_credential``
    stays create-or-refuse: a dialog creating a second ``telegram`` must not overwrite the first.)"""
    project = await get_project(project_id)
    if project is None:
        raise CredentialError("project not found")
    own = await credential_named(str(manifest.get("name") or ""), project)
    if own is not None and own.scope == SCOPE_PROJECT:
        return await save_credential(manifest=manifest, typeid=str(own.typeid), require_setup=require_setup)
    return await save_credential(manifest=manifest, scope=SCOPE_PROJECT, project_id=project_id, require_setup=require_setup)


async def _release_orphaned_bindings(env_vars: list[str]) -> None:
    """After a credential is gone: drop this computer's store exception for each of its variables no
    remaining credential declares. Saving a credential with a store pins its variables there on this
    computer (``save_credential`` → ``keep_in``); left behind, that pin silently routes the NEXT
    credential of the same variable — another project's, declared from the shipped template — into
    the deleted one's store instead of the default. A variable another credential still declares
    keeps its pin (its values are read through it), and a named deployment's exceptions are a
    person's deployment config, never touched here."""
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.builtin.deployment import Deployment  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    if not env_vars:
        return
    # Only AUTHORED credentials count: a shipped template (system scope) holds no values and is
    # read through no binding.
    authored = ExpressionNode(op=QueryOp.OR, operands=[
        ExpressionNode(op=QueryOp.EQ, operands=["scope", SCOPE_USER]),
        ExpressionNode(op=QueryOp.EQ, operands=["scope", SCOPE_PROJECT]),
    ])
    declared = {name for other in await Credential.get_all(QueryFilter(match=authored)) for name in other.var_names()}
    orphaned = [name for name in env_vars if name not in declared]
    if orphaned:
        await (await Deployment.this_computer()).release(orphaned)


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
        remove_credential_files(spec)
        if spec.asset_ref and Path(spec.asset_ref).is_dir():
            Asset.from_path(spec.asset_ref).remove()
        await spec.delete()
        await _release_orphaned_bindings(names)
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


def _take_dropped(file: str, key: str = "values") -> dict[str, str]:
    """Read and delete a dropped file's ``key`` map; only a file inside the drop folder is ever read."""
    import json  # noqa: PLC0415

    path = Path(file).resolve()
    if path.parent != drop_folder().resolve() or not path.is_file():
        raise CredentialError("not a dropped values file")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    finally:
        path.unlink(missing_ok=True)
    values = raw.get(key) if isinstance(raw, dict) else None
    if not isinstance(values, dict):
        raise CredentialError(f"the dropped file holds no {key}")
    return {str(k): str(v) for k, v in values.items() if v}


async def place_connections(file: str) -> dict[str, Any]:
    """The hub pushed this deployment's authorized connections (``{"connections": {provider: access token}}``):
    each becomes this machine's own sign-in for that provider (``record_credential``), so every reader here —
    data sources, ``flow connections``, ``connections.require`` — finds it locally and never asks the hub for a
    token. ``{placed, failed}`` by provider; names only."""
    from flow_sdk.app.actions.desktop_oauth import record_credential  # noqa: PLC0415
    from flow_sdk.builtin.user import User  # noqa: PLC0415

    tokens = _take_dropped(file, "connections")
    user = await User.get_local()
    placed: list[str] = []
    failed: dict[str, str] = {}
    for provider, token in tokens.items():
        try:
            if await record_credential(user, provider, token):
                placed.append(provider)
            else:
                failed[provider] = "not recorded"
        except Exception as e:  # noqa: BLE001 — reported per provider, names only
            failed[provider] = type(e).__name__
    return {"placed": sorted(placed), "failed": failed}


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
    manifest = {**_manifest_of(existing), "vars": {**(existing.vars or {}), **{v: {} for v in new}}}
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
    ``{placed, failed}`` names, and ``verified``: the sources here that read them, verified now."""

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
    return {"placed": sorted(placed), "failed": failed, "verified": await _verify_readers(placed)}


async def _verify_readers(names: list[str]) -> dict[str, str]:
    """Verify every source on this machine that loads one of ``names`` (``DataSource.credentials``): a source
    that arrived with the project waits in SETUP for this machine's own account, and on a deployment's machine
    that account IS the placed values. ``{source name: "ready" | detail}`` — a verify that fails is reported,
    never raised."""
    import asyncio  # noqa: PLC0415

    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    placed = set(names)
    # Only drivers that can read a store at all; each of their sources is then asked what it loads.
    providers = [p for p, d in DRIVERS.items() if d.manifest is not None and d.manifest.auth is not None]
    rows = await asyncio.gather(*(DataSource.get_all({"provider": p}) for p in providers))
    readers = [s for batch in rows for s in batch or [] if placed & set(s.credentials.names())]

    async def verify(source) -> str:
        try:
            verdict = await source.verify() or {}
        except Exception as e:  # noqa: BLE001 — a class only: a detail may quote a provider's answer
            return type(e).__name__
        return "ready" if verdict.get("ready") else str(verdict.get("detail") or "not ready")

    verdicts = await asyncio.gather(*(verify(s) for s in readers))
    return {str(s.name or s.id): v for s, v in zip(readers, verdicts)}


async def teardown_sources() -> dict[str, str]:
    """Every source on this machine undoes what it set up at its provider (``DataSource.teardown``) --
    what a deployment's machine does just before the hub destroys it. ``{source name: report}``."""
    import asyncio  # noqa: PLC0415

    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    rows = await asyncio.gather(*(DataSource.get_all({"provider": p}) for p in DRIVERS.keys()))
    sources = [s for batch in rows for s in batch or []]
    reports = await asyncio.gather(*(s.teardown() for s in sources))
    return {str(s.name or s.id): r for s, r in zip(sources, reports)}


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


# ── the project's vaults: values between people ───────────────────────────────
#
# A value travels from one person to another ONLY through one of the project's vaults (``secret_vaults``
# in ``project_manifest.json``, each a group of secrets in one secret manager): the sharer PUBLISHES
# their local value into a vault, the credential spec travels with the project carrying each variable's
# ``secret_ref`` ``{vault, key}``, and the receiver FETCHES into their own store. Every verb answers
# names only; a value is never shown or logged.


def _store_refusal(e: Exception) -> Optional[CredentialError]:
    """A store's own refusal as a fixable CredentialError, or None for anything else."""
    from flow_sdk.builtin.credential_store import UnknownVault  # noqa: PLC0415
    from flow_sdk.secrets import StoreAccessDenied, StoreNeedsConnection  # noqa: PLC0415

    from flow_sdk.secrets.managers import UnknownSecretManager  # noqa: PLC0415

    if isinstance(e, UnknownVault):
        return CredentialError(str(e), code="unknown_vault")
    if isinstance(e, UnknownSecretManager):
        return CredentialError(str(e), code="unknown_secret_manager")
    if isinstance(e, StoreNeedsConnection):
        return CredentialError(f"the secret manager needs a sign-in: {e}", code="needs_connection")
    if isinstance(e, StoreAccessDenied):
        return CredentialError(f"no access to the vault: {e}", code="denied")
    return None


@contextmanager
def store_errors():
    """Inside it, a store's own refusal surfaces as a fixable :class:`CredentialError`; anything else as it is."""
    try:
        yield
    except Exception as e:
        refusal = _store_refusal(e)
        if refusal is None:
            raise
        raise refusal from e


async def _project_of(project_id: str) -> "Project":
    project = await get_project(project_id)
    if project is None:
        raise CredentialError("project not found")
    return project


def _vault_specs(project: "Project") -> dict[str, Any]:
    from flow_sdk.builtin.credential_store import vaults_of  # noqa: PLC0415

    return vaults_of(project)


def _vault_spec(vaults: Mapping[str, Any], vault: str) -> Any:
    """``vault`` out of the project's ``vaults`` (:func:`_vault_specs`); a CredentialError when it has none by that name."""
    if not vaults:
        raise CredentialError("this project has no vault — set up a secret manager to share values", code="no_vault")
    if vault not in vaults:
        raise CredentialError(f"this project has no vault named {vault!r}", code="unknown_vault")
    return vaults[vault]


def _vault_store(vaults: Mapping[str, Any], vault: str):
    """The store ``vault`` names, from the manifest already read into ``vaults``."""
    from flow_sdk.secrets import managers  # noqa: PLC0415  (lazy: managers load assets)

    spec = _vault_spec(vaults, vault)
    with store_errors():
        return managers.store_for(spec)


async def _shared_credential(name: str, project_id: str) -> tuple["Project", "Credential", list[str]]:
    """The project, its credential ``name`` and the names of its stored vars."""
    project = await _project_of(project_id)
    spec = await credential_named(name, project)
    if spec is None:
        raise CredentialError(f"no credential named {name!r} in this project")
    stored = list(spec.stored_var_names())
    if not stored:
        raise CredentialError(f"{name} holds no values to share (a sign-in or a grant lives elsewhere)")
    return project, spec, stored


async def _write_refs(spec: "Credential", refs: dict[str, Any]) -> None:
    """Record ``{ENV_VAR: SecretRefSpec}`` in credential.json through the one save path."""
    manifest = _manifest_of(spec)
    manifest["vars"] = {
        var: {**v.model_dump(mode="json", exclude_defaults=True), **({"secret_ref": refs[var].model_dump(mode="json")} if var in refs else {})}
        for var, v in spec.vars.items()
    }
    await save_credential(manifest=manifest, typeid=str(spec.typeid), require_setup=False)


async def publish(name: str, project_id: str, vault: str) -> dict[str, Any]:
    """Copy this computer's values of credential ``name`` into ``vault``: a variable lacking a
    ``secret_ref`` gets ``{vault, key: ENV_VAR}`` written into credential.json; one that has a ref is
    published to the vault its ref names. ``{published, not_here, vault}`` — names only. A variable
    with no value here is reported, never cleared in the vault."""
    from flow_sdk.builtin.credential_resolver import resolve_project_secrets  # noqa: PLC0415
    from flow_sdk.schema.data_spec.secret_vault_spec import SecretRefSpec  # noqa: PLC0415

    project, spec, stored = await _shared_credential(name, project_id)
    vaults = _vault_specs(project)
    _vault_spec(vaults, vault)
    new_refs = {var: SecretRefSpec(vault=vault, key=var) for var in stored if spec.vars[var].secret_ref is None}
    refs = {var: spec.vars[var].secret_ref or new_refs[var] for var in stored}
    mine = await resolve_project_secrets(project, only=stored, placement=await Placement.of(None))
    by_vault: dict[str, dict[str, Any]] = {}
    for var, value in mine.items():
        by_vault.setdefault(refs[var].vault, {})[refs[var].key] = value
    with store_errors():
        for vault_name, values in by_vault.items():
            await _vault_store(vaults, vault_name).save(values, description=f"{spec.name} · {', '.join(sorted(values))}")
    if new_refs:
        await _write_refs(spec, new_refs)
    return {"published": sorted(mine), "not_here": sorted(set(stored) - set(mine)), "vault": vault}


async def fetch(name: str, project_id: str) -> dict[str, Any]:
    """Fetch credential ``name``'s values from the vaults its variables' refs name into this computer's
    store (``.env.local`` by default — the same writer as ``flow credentials set``):
    ``{fetched, missing, denied: [vault], vaults}`` — names only. ``missing``: no ref, or the vault
    holds no value; ``denied``: vaults this person may not read (the rest are still fetched)."""
    project, spec, stored = await _shared_credential(name, project_id)
    groups: dict[str, dict[str, str]] = {}
    for var in stored:
        ref = spec.vars[var].secret_ref
        if ref is not None:
            groups.setdefault(ref.vault, {})[var] = ref.key
    if not groups:
        raise CredentialError(f"{name} names no vault for its values — publish them first", code="no_vault")
    vaults = _vault_specs(project)
    values: dict[str, str] = {}
    denied: list[str] = []
    for vault_name, keys in groups.items():
        try:
            held = await _vault_store(vaults, vault_name).load(list(keys.values()))
        except Exception as e:
            refusal = e if isinstance(e, CredentialError) else _store_refusal(e)
            if refusal is None:
                raise
            if refusal.code == "denied":
                denied.append(vault_name)
                continue
            raise refusal from e
        values.update({var: held[key].get_secret_value() for var, key in keys.items() if key in held})
    if values:
        await set_credential_values(str(spec.typeid), values, None)
        await _reverify_waiting_sources(spec.name, project)
    return {"fetched": sorted(values), "missing": sorted(set(stored) - set(values)), "denied": sorted(denied), "vaults": sorted(groups)}


async def vault_check(project_id: str, vault: str) -> dict[str, Any]:
    """Can this computer reach ``vault`` now (manager installed, signed in)? ``{vault, ready, reason}``."""
    from flow_sdk.secrets import managers  # noqa: PLC0415

    spec = _vault_spec(_vault_specs(await _project_of(project_id)), vault)
    try:
        ready = bool(await managers.run_check(spec))
        reason = "" if ready else f"the {spec.manager} secret manager is not installed or not signed in"
    except Exception as e:
        ready, reason = False, str(_store_refusal(e) or e)
    return {"vault": vault, "ready": ready, "reason": reason}


async def grant(project_id: str, vault: str, email: str) -> dict[str, Any]:
    """Give ``email`` read access to ``vault`` through its manager's own sharing: ``{vault, email}``."""
    from flow_sdk.secrets import managers  # noqa: PLC0415

    if not email.strip():
        raise CredentialError("grant needs the email of the person to give access")
    spec = _vault_spec(_vault_specs(await _project_of(project_id)), vault)
    with store_errors():
        await managers.run_grant(spec, email.strip())
    return {"vault": vault, "email": email.strip()}


def list_managers() -> list[dict[str, Any]]:
    """Every installed secret manager, as its ``secret_manager.json``."""
    from flow_sdk.secrets import managers  # noqa: PLC0415

    return [m.model_dump(mode="json") for m in managers.list_managers()]


async def list_vaults(project_id: str) -> dict[str, Any]:
    """The project's vaults by name: ``{vaults: {name: {manager, config}}}`` — places, never values."""
    return {"vaults": {n: v.model_dump(mode="json") for n, v in _vault_specs(await _project_of(project_id)).items()}}


async def set_vault(project_id: str, name: str, vault: Optional[Mapping[str, Any]]) -> dict[str, Any]:
    """Add/replace (``vault``) or remove (None) the project's vault ``name``; answers :func:`list_vaults`."""
    from flow_sdk.assets.project_manifest import ManifestError, set_secret_vault  # noqa: PLC0415

    if not name.strip():
        raise CredentialError("a vault needs a name")
    project = await _project_of(project_id)
    try:
        set_secret_vault(Path(project.fs_storage_mount_path), name.strip(), vault)
    except (ManifestError, KeyError, ValueError, LookupError) as e:
        raise CredentialError(str(e)) from e
    await project._reindex_manifest()
    return await list_vaults(project_id)


# ── test: are the values GOOD, not only present ─────────────────────────────


def _scrubbed(text: str, values: list[str]) -> str:
    """``text`` with every value replaced — a provider's error may echo the key it refused."""
    for value in sorted((v for v in values if v), key=len, reverse=True):
        text = text.replace(value, "•••")
    return text


async def test_credential(name: str, project_id: str = "") -> dict[str, Any]:
    """Run credential ``name``'s ``test`` with this computer's values in its environment and its own folder as
    the working folder, record the answer on the row (``Credential.test_result``, this machine only) and
    return ``{name, has_test, state, detail, at}`` — ``state`` ``ok`` / ``invalid`` / ``error``, or
    ``untested`` when the credential declares no test. Values never leave: the detail is scrubbed."""
    from datetime import datetime, timezone  # noqa: PLC0415

    from flow_sdk.builtin.credential import TEST_FIELD  # noqa: PLC0415
    from flow_sdk.builtin.credential_resolver import resolve_project_secrets  # noqa: PLC0415
    from flow_sdk.core.compute.exec import run_shell  # noqa: PLC0415
    from flow_sdk.core.setup.skip_mark import write_projection  # noqa: PLC0415
    from flow_sdk.schema.data_spec.compute_op_spec import CHECK_TIMEOUT  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_status_spec import CredentialTestResultSpec  # noqa: PLC0415

    project = await get_project(project_id) if project_id else None
    spec = await credential_named(name, project)
    if spec is None:
        raise CredentialError(f"no credential named {name!r} in this project or the user scope")
    folder = spec.folder or Path.home()
    test = spec.declared_test()
    if test is None:
        return {"name": spec.name, "has_test": False, "state": "untested", "detail": "", "at": ""}
    command = test.command_for()
    values = await resolve_project_secrets(project, only=spec.stored_var_names(), placement=await Placement.of(None))
    plain = {k: v.get_secret_value() for k, v in values.items()}
    if not command:
        state, detail = "error", "the test has no command for this computer"
    elif missing := [v for v in spec.required_var_names() if v in spec.stored_var_names() and v not in plain]:
        state, detail = "error", f"no value here for {', '.join(missing)}"
    else:
        said = await run_shell(command, timeout_seconds=test.timeout(CHECK_TIMEOUT), workdir=folder, extra_env=plain)
        first = next((ln.strip() for ln in (said.stderr or said.stdout or "").splitlines() if ln.strip()), "")
        if said.timed_out:
            state, detail = "error", "the provider did not answer in time"
        elif said.returncode == 0:
            state, detail = "ok", ""
        elif said.returncode == 127:
            state, detail = "error", f"{command.split()[0]} is not installed"
        else:
            state, detail = "invalid", _scrubbed(first, list(plain.values()))[:200] or f"rejected (exit {said.returncode})"
    result = CredentialTestResultSpec(state=state, detail=detail, at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    await write_projection(spec, TEST_FIELD, result)
    return {"name": spec.name, "has_test": True, **result.model_dump(mode="json")}
