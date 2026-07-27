"""Materialize hub-side Organization / Team rows locally as ``remote=True``.

Organizations and teams are hub-authoritative. The desktop client mirrors them
into the local store as ``remote=True`` entities at the hub id so the profile
chip, the Organization settings tab, and member lists resolve from a real local
row (and stay refreshable from the hub). Used on two paths:

  * cloud login — the login payload embeds the user's organization;
  * invitation accept — the accepted org/team becomes a local membership.

This mirrors ``_upsert_hub_conversation_metadata`` (the Conversation precedent)
but is intentionally tiny: orgs/teams have no children, projections, or
message_ids to guard, only flat metadata fields.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional, Type

from pydantic import TypeAdapter

from flow_sdk._compat import UTC
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.organization import Organization
from flow_sdk.core.entity.entity_model import Entity, remote_reflection

logger = logging.getLogger(__name__)

# Flat metadata fields we mirror from the hub payload, when present on the type.
# ``name`` AND ``title`` both ride: every entity carries both slots on both
# sides now, so whichever one the type authors arrives verbatim. There is no
# title→name coercion here — a project's label is ``name`` on the hub too.
_MIRRORED_FIELDS = (
    "name",
    "title",
    "git_origin",
    "account",
    "domain",
    "icon",
    "members",
    "shared_context_entities",
    "shared_context_origins",
    "shared_secret_origins",
)


_FIELD_ADAPTERS: dict[tuple[type, str], Any] = {}


def _validated_field(cls: Type[Entity], name: str, value: Any) -> Any:
    """Coerce a raw hub value into the target field's declared type.

    The create path gets this free from ``cls.model_validate``; the update path
    used to ``setattr`` raw JSON, so a typed field (e.g. ``Project.git_origin``)
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
    """Parse one value-free shared secret pointer → ``(name, env_var, locator,
    sod_store)``. Accepts every non-``local`` provider kind (env-local / gcp /
    1password / flowpad-hub); ``local`` (sodot-by-name) is machine-specific and
    never travels."""
    from flow_sdk.builtin.secret_origin import is_valid_secret_origin_env_var  # noqa: PLC0415
    from flow_sdk.builtin.secret_origin_driver import normalize_secret_origin_kind  # noqa: PLC0415
    from flow_sdk.builtin.secret_origin_field import SECRET_ORIGIN_ADAPTER  # noqa: PLC0415

    locator_data = item.get("locator") if isinstance(item.get("locator"), dict) else None
    if not locator_data:
        logger.debug("[membership-sync] secret origin missing locator")
        return None
    kind = normalize_secret_origin_kind(locator_data.get("kind") or item.get("kind"))
    if kind == "local":
        return None  # machine-local; a sod_name is meaningless off-machine
    try:
        locator = SECRET_ORIGIN_ADAPTER.validate_python({**locator_data, "kind": kind})
    except Exception as exc:  # noqa: BLE001
        logger.debug("[membership-sync] invalid secret origin locator: %s", exc)
        return None
    if kind == "flowpad-hub" and not (getattr(locator, "secret_id", "") or "").strip():
        logger.debug("[membership-sync] flowpad-hub secret origin missing secret_id")
        return None
    env_var = (item.get("env_var") or "").strip()
    if not env_var or not is_valid_secret_origin_env_var(env_var):
        logger.debug("[membership-sync] invalid secret origin env_var: %r", env_var)
        return None
    name = (item.get("name") or "").strip()
    if not name:
        return None
    sod_store = (item.get("sod_store") or "").strip()
    return name, env_var, locator, sod_store


async def materialize_remote_membership_entity(
    cls: Type[Entity],
    data: dict[str, Any],
    someone_typeid: str | None = None,
    *,
    notify: bool = True,
) -> Optional[Entity]:
    """Upsert a hub Organization/Team dict into the local store (``remote=True``).

    Idempotent: re-running with the same payload is a no-op when nothing
    changed. Returns the local row, or ``None`` when the payload has no id.
    """
    if not isinstance(data, dict):
        return None
    ent_id = (str(data.get("id") or "")).strip()
    if not ent_id:
        return None

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
    from flow_sdk.builtin.fs_origin_field import FS_ORIGIN_ADAPTER  # noqa: PLC0415

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
            origin = FS_ORIGIN_ADAPTER.validate_python(raw_origin)
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
        data.get("shared_secret_origins")
        if has_explicit_shared
        else getattr(project, "shared_secret_origins", None)
    ) or {}
    if not isinstance(shared, dict):
        return 0

    from flow_sdk.builtin.secret_origin import SecretOrigin  # noqa: PLC0415

    changed = False
    count = 0
    expected_shared_typeids: set[str] = set()
    normalized_shared: dict[str, dict[str, Any]] = {}
    for item in shared.values():
        if not isinstance(item, dict):
            continue
        parsed = _shared_secret_origin_payload(item)
        if parsed is None:
            continue
        name, env_var, locator, sod_store = parsed
        secret = await SecretOrigin.mint_for(
            locator=locator, name=name, env_var=env_var, sod_store=sod_store, remote=True
        )
        expected_shared_typeids.add(str(secret.typeid))
        normalized_shared[str(secret.typeid)] = {
            "name": name,
            "env_var": env_var,
            "kind": locator.kind,
            "locator": locator.model_dump(mode="json"),
            "sod_store": secret.effective_sod_store(),
        }
        changed = project.add_shared_context_entities(
            secret.typeid,
            data=secret.context_data(scope="shared"),
        ) or changed
        count += 1

    if has_explicit_shared:
        stale = [
            tid
            for tid in project.context_of_type("secret_origin", bucket="shared")
            if str(tid) not in expected_shared_typeids
        ]
        if stale:
            changed = project.remove_shared_context_entities(*stale) or changed

    if (
        getattr(project, "shared_secret_origins", None) != normalized_shared
        and hasattr(project, "shared_secret_origins")
    ):
        setattr(project, "shared_secret_origins", normalized_shared)
        changed = True
    if changed:
        project.fetched_at = datetime.now(UTC)
        with remote_reflection():
            await project.save(someone_typeid, notify=notify)
    return count
