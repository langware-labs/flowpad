"""Materialize hub-side membership-container rows locally as ``remote=True``.

Organizations, teams, and projects are hub-authoritative once shared. The
desktop client mirrors them into the local store as ``remote=True`` entities at
the hub id so local surfaces resolve from a real row (and stay refreshable from
the hub). Used on three paths:

  * cloud login — the login payload embeds the user's organization;
  * invitation accept — the accepted org/team becomes a local membership.
  * live assignment — the Hub pushes the granted container to the recipient.

This mirrors ``_upsert_hub_conversation_metadata`` (the Conversation precedent)
but keeps container-specific expansion here: organizations and teams need only
flat metadata, while projects additionally materialize their shared Folder and
SecretOrigin declarations.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional, Type

from pydantic import TypeAdapter

from flow_sdk._compat import UTC
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.builtin.organization import Organization
from flow_sdk.core.entity.entity_model import Entity, remote_reflection
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType

from flow_sdk.fs_store.serializer.hub import HubSerializer

logger = logging.getLogger(__name__)


# The membership containers whose full Hub payload can be mirrored directly.
# Keep this set shared by invitation previews and live assignment ingest so a
# newly supported container cannot silently work on only one receive path.
MEMBERSHIP_MIRROR_TYPES: frozenset[str] = frozenset(
    {
        BuiltinEntityType.ORGANIZATION.value,
        BuiltinEntityType.TEAM.value,
        BuiltinEntityType.PROJECT.value,
    }
)

# Flat metadata fields we mirror from the hub payload, when present on the type.
# ``name`` AND ``title`` both ride: every entity carries both slots on both
# sides now, so whichever one the type authors arrives verbatim. There is no
# title→name coercion here — a project's label is ``name`` on the hub too.
_MIRRORED_FIELDS = (
    "name",
    "title",
    "origin",
    "helpdesk",
    "account",
    "domain",
    "icon",
    # The language a project is worked in: a property of the WORK, so a
    # recipient — a person accepting an invitation, or the box behind a sandbox
    # handover — opens it in the language its author chose instead of falling
    # back to English. (Per-device UI state like ``last_mode`` deliberately does
    # not travel and must not be added here.)
    "locale",
    "members",
    "shared_context_entities",
    "shared_context_origins",
    "shared_secret_origins",
)


_FIELD_ADAPTERS: dict[tuple[type, str], Any] = {}


def _validated_field(cls: Type[Entity], name: str, value: Any) -> Any:
    """Coerce a raw hub value into the target field's declared type.

    The create path gets this free from ``cls.model_validate``; the update path
    used to ``setattr`` raw JSON, so a typed field (e.g. ``Project.origin``)
    ended up holding a dict and every consumer had to re-check. Validate here,
    at the mirror boundary, and fall back to the raw value if it doesn't fit.
    """
    if value is None:
        return None
    key = (cls, name)
    adapter = _FIELD_ADAPTERS.get(key)
    if adapter is None:
        adapter = _FIELD_ADAPTERS[key] = TypeAdapter(cls.model_fields[name].annotation)
    try:
        return adapter.validate_python(value)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[membership-sync] %s.%s did not validate: %s", cls.__name__, name, exc)
        return value


def _shared_secret_origin_payload(
    item: dict[str, Any],
) -> tuple[str, str, Any, str] | None:
    """Parse one value-free shared secret declaration → ``(name, env_var,
    locator, sod_store)``.

    EVERY kind is accepted, ``local`` included: a receiver must see a
    declaration in order to be warned that its value is missing here. The
    sender already strips the machine-specific coordinate (a ``sod_name`` names
    an entry in their keychain), so what arrives is a value-free declaration
    the receiver satisfies from their own store.
    """
    from flow_sdk.builtin.secret_origin import is_valid_secret_origin_env_var  # noqa: PLC0415
    from flow_sdk.builtin.secret_origin_driver import normalize_secret_origin_kind  # noqa: PLC0415
    from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER  # noqa: PLC0415

    locator_data = item.get("locator") if isinstance(item.get("locator"), dict) else None
    if not locator_data:
        logger.debug("[membership-sync] secret origin missing locator")
        return None
    kind = normalize_secret_origin_kind(locator_data.get("kind") or item.get("kind"))
    try:
        locator = SECRET_ORIGIN_ADAPTER.validate_python({**locator_data, "kind": kind})
    except Exception as exc:  # noqa: BLE001
        logger.debug("[membership-sync] invalid secret origin locator: %s", exc)
        return None
    if kind == "flowpad-hub":
        # Either the typed coordinates or the legacy opaque id — but not neither,
        # or there is nothing on the hub to point at.
        has_coords = bool((getattr(locator, "project_id", "") or "").strip())
        has_legacy = bool((getattr(locator, "secret_id", "") or "").strip())
        if not has_coords and not has_legacy:
            logger.debug("[membership-sync] flowpad-hub secret origin has no hub coordinates")
            return None
    env_var = (item.get("env_var") or "").strip()
    if not env_var or not is_valid_secret_origin_env_var(env_var):
        logger.debug("[membership-sync] invalid secret origin env_var: %r", env_var)
        return None
    # The env var IS the identity, so it is a fine default display name; a
    # missing name is not a reason to drop the declaration.
    name = (item.get("name") or "").strip() or env_var
    sod_store = (item.get("sod_store") or "").strip()
    return name, env_var, locator, sod_store


async def materialize_remote_membership_entity(
    cls: Type[Entity],
    data: dict[str, Any],
    someone_typeid: str | None = None,
    *,
    notify: bool = True,
) -> Optional[Entity]:
    """Upsert a Hub membership-container dict locally (``remote=True``).

    Idempotent: re-running with the same payload is a no-op when nothing
    changed. Returns the local row, or ``None`` when the payload has no id.
    """
    if not isinstance(data, dict):
        return None
    ent_id = (str(data.get("id") or "")).strip()
    if not ent_id:
        return None

    data = HubSerializer.unwire(cls, data)   # the hub's wire names → field names
    fields = tuple(k for k in _MIRRORED_FIELDS if k in cls.model_fields)
    existing = await cls.get_one({"id": ent_id})
    if existing is None:
        payload: dict[str, Any] = {"id": ent_id, "remote": True}
        for k in fields:
            if data.get(k) is not None:
                payload[k] = data[k]
        if data.get("created_date") is not None:
            payload["created_date"] = data["created_date"]
        if data.get("updated_date") is not None:
            payload["updated_date"] = data["updated_date"]
        payload["fetched_at"] = datetime.now(UTC)
        ent = cls.model_validate(payload)
        ent.id = ent_id
        # Pure reflection of the hub row — preserve created_by/dates verbatim,
        # never stamp the local sync user.
        with remote_reflection():
            ent = await ent.save(someone_typeid, notify=notify)
        await materialize_project_context_folders(ent, data, someone_typeid, notify=notify)
        await materialize_project_secret_origins(ent, data, someone_typeid, notify=notify)
        return ent

    changed = False
    for k in fields:
        v = _validated_field(cls, k, data.get(k))
        if v is not None and getattr(existing, k, None) != v:
            setattr(existing, k, v)
            changed = True
    if not existing.remote:
        existing.remote = True
        changed = True
    if changed:
        existing.fetched_at = datetime.now(UTC)
        with remote_reflection():
            await existing.save(someone_typeid, notify=notify)
    await materialize_project_context_folders(existing, data, someone_typeid, notify=notify)
    await materialize_project_secret_origins(existing, data, someone_typeid, notify=notify)
    return existing


async def materialize_remote_organization(
    data: dict[str, Any], someone_typeid: str | None = None, *, notify: bool = True
) -> Optional[Organization]:
    return await materialize_remote_membership_entity(Organization, data, someone_typeid, notify=notify)


async def materialize_project_context_folders(
    project: Entity,
    data: dict[str, Any],
    someone_typeid: str | None = None,
    *,
    notify: bool = True,
) -> int:
    """Materialize received project shared context Folder refs.

    Accept never clones. It creates remote Folder rows from the transportable
    origin map and links them with empty sidecars; project-open lazy resolve
    later stamps receiver-local paths.
    """
    if getattr(project, "type", None) != "project" or not isinstance(data, dict):
        return 0
    raw_refs = data.get("shared_context_entities") or []
    raw_origins = data.get("shared_context_origins") or getattr(project, "shared_context_origins", None) or {}
    if not isinstance(raw_refs, list) or not isinstance(raw_origins, dict):
        return 0

    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415
    from flow_sdk.fs_store.origin.field import ORIGIN_ADAPTER  # noqa: PLC0415

    changed = False
    count = 0
    for raw_ref in raw_refs:
        try:
            tid = TypeId.to_typeid(raw_ref)
        except Exception:
            continue
        if tid.type != "folder":
            continue
        raw_origin = raw_origins.get(str(tid)) or (raw_origins.get(tid.id) if tid.id else None)
        if raw_origin is None:
            continue
        try:
            origin = ORIGIN_ADAPTER.validate_python(raw_origin)
        except Exception as exc:  # noqa: BLE001
            logger.debug("[membership-sync] invalid shared context origin for %s: %s", tid, exc)
            continue
        if not origin.transportable:
            continue
        folder = await Folder.mint_for_origin(origin)
        folder_changed = False
        if folder.origin is None:
            folder.origin = origin
            folder_changed = True
        if not folder.remote:
            folder.remote = True
            folder_changed = True
        if folder_changed:
            with remote_reflection():
                await folder.save(someone_typeid, notify=notify)
        changed = project.add_shared_context_entities(folder.typeid) or changed
        count += 1

    if getattr(project, "shared_context_origins", None) != raw_origins and hasattr(project, "shared_context_origins"):
        setattr(project, "shared_context_origins", dict(raw_origins))
        changed = True
    if changed:
        project.fetched_at = datetime.now(UTC)
        with remote_reflection():
            await project.save(someone_typeid, notify=notify)
    return count


async def materialize_project_secret_origins(
    project: Entity,
    data: dict[str, Any],
    someone_typeid: str | None = None,
    *,
    notify: bool = True,
) -> int:
    """Materialize received project secret pointers from hub metadata.

    The hub payload is value-free. This creates local SecretOrigin rows and
    links them into the project's shared context bucket so runtime injection can
    resolve whatever values are available on this machine.
    """
    if getattr(project, "type", None) != "project" or not isinstance(data, dict):
        return 0
    has_explicit_shared = "shared_secret_origins" in data
    shared = (
        data.get("shared_secret_origins") if has_explicit_shared else getattr(project, "shared_secret_origins", None)
    ) or {}
    if not isinstance(shared, dict):
        return 0

    from flow_sdk.builtin.secret_origin import SecretOrigin  # noqa: PLC0415

    changed = False
    count = 0
    expected_shared_typeids: set[str] = set()
    normalized_shared: dict[str, dict[str, Any]] = {}
    seen_env_vars: set[str] = set()
    for item in shared.values():
        if not isinstance(item, dict):
            continue
        parsed = _shared_secret_origin_payload(item)
        if parsed is None:
            continue
        name, env_var, locator, sod_store = parsed
        # env_var is unique within a project by definition, so two payload
        # entries naming the same one are a sender-side bug. First wins and we
        # say so — last-wins would silently clobber.
        if env_var in seen_env_vars:
            logger.warning(
                "[membership-sync] duplicate env_var %r in shared_secret_origins; keeping the first",
                env_var,
            )
            continue
        seen_env_vars.add(env_var)
        secret = await SecretOrigin.mint_for(
            project_id=str(project.id),
            env_var=env_var,
            locator=locator,
            name=name,
            sod_store=sod_store,
            remote=True,
        )
        expected_shared_typeids.add(str(secret.typeid))
        normalized_shared[str(secret.typeid)] = {
            "name": name,
            "project_id": str(project.id),
            "env_var": env_var,
            "kind": locator.kind,
            "locator": locator.model_dump(mode="json"),
            "sod_store": secret.effective_sod_store(),
        }
        changed = (
            project.add_shared_context_entities(
                secret.typeid,
                data=secret.context_data(scope="shared"),
            )
            or changed
        )
        count += 1

    if has_explicit_shared:
        stale = [
            tid
            for tid in project.context_of_type("secret_origin", bucket="shared")
            if str(tid) not in expected_shared_typeids
        ]
        if stale:
            changed = project.remove_shared_context_entities(*stale) or changed

    if getattr(project, "shared_secret_origins", None) != normalized_shared and hasattr(
        project, "shared_secret_origins"
    ):
        setattr(project, "shared_secret_origins", normalized_shared)
        changed = True
    if changed:
        project.fetched_at = datetime.now(UTC)
        with remote_reflection():
            await project.save(someone_typeid, notify=notify)
    return count
