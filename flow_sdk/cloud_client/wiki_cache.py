"""Hub Wiki reads materialized into the desktop's local entity cache.

The frontend deliberately has one API origin: the local backend.  A Hub Wiki
Dock route therefore asks this service to execute the canonical Hub graph
calls, then cache the returned Wiki and target metadata as ``remote=True`` local
rows.  Content is not copied here.  It continues through the normal
``record/refs`` + entity ``fs`` path, whose remote-file miss handler pulls bytes
from the Hub on demand.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.api.type_id import TypeId
from flow_sdk.core.entity.entity_model import Entity, remote_reflection
from flow_sdk.db.db_entity import DBEntity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

from .transport.hub_http import hub_get


class HubWikiCacheError(RuntimeError):
    """The Hub Wiki request could not be completed or materialized."""


def _cache_payload(entity_cls: type[Entity], raw: dict[str, Any]) -> dict[str, Any]:
    # Sender-local placement (asset_ref, path, project_id, vault_root, …) must
    # never be adopted by a receiving desktop: exactly the fields the type
    # declares ``Sharing.PRIVATE`` — one declaration, not a second list here.
    private = entity_cls.fields_not_in_bundle()
    payload = {key: value for key, value in raw.items() if key not in private and entity_cls.is_api_field(key)}
    payload["id"] = str(raw["id"])
    payload["remote"] = True
    return payload


async def materialize_hub_entity(
    raw: dict[str, Any],
    *,
    owner: DBEntity | TypeId | str | None = None,
) -> Entity:
    """Upsert one Hub entity as metadata-only local cache state.

    This intentionally calls the DB-level save seam: a Hub cache row must not
    run local filesystem placement or create a default asset body.  Attribution
    remains the Hub's under ``remote_reflection``; ``owner`` only grants the
    current local user access to a newly cached row.
    """

    entity_type = str(raw.get("type") or "").strip()
    entity_id = str(raw.get("id") or "").strip()
    if not entity_type or not entity_id:
        raise HubWikiCacheError("Hub entity response has no type/id")

    entity_cls = SchemaRegistry.get_entity_cls(entity_type)
    if entity_cls is None:
        raise HubWikiCacheError(f"Hub entity type is not registered locally: {entity_type}")

    payload = _cache_payload(entity_cls, raw)
    existing = await entity_cls.get_one({"id": entity_id})
    if existing is None:
        entity = entity_cls.model_validate(payload)
    else:
        entity = existing
        for key, value in payload.items():
            if key in {"id", "type"}:
                continue
            if getattr(entity, key, None) != value:
                setattr(entity, key, value)

    with remote_reflection():
        return await DBEntity.save(entity, owner, notify=False)


async def resolve_hub_wiki(
    wiki_ref: str,
    word: str,
    *,
    owner: DBEntity | TypeId | str | None = None,
) -> dict[str, Any]:
    """Resolve through the canonical Hub Wiki API and warm local metadata.

    The returned value remains the exact resolver identity union.  Wiki and
    target payloads are side effects in the local cache, never embedded into the
    resolver result.
    """

    hub_wiki = await hub_get(BuiltinEntityType.WIKI, wiki_ref)
    if not isinstance(hub_wiki, dict) or not hub_wiki.get("id"):
        raise HubWikiCacheError(f"Hub Wiki not found or unavailable: {wiki_ref}")
    wiki = await materialize_hub_entity(hub_wiki, owner=owner)

    result = await hub_get(
        BuiltinEntityType.WIKI,
        str(wiki.id),
        action="resolve",
        params={"word": word},
    )
    if not isinstance(result, dict) or result.get("kind") not in {
        "resolved",
        "missing",
        "ambiguous",
    }:
        raise HubWikiCacheError("Invalid Hub Wiki resolve response")
    if result["kind"] != "resolved":
        return {"kind": result["kind"]}

    try:
        target = TypeId.to_typeid(result["target_typeid"])
        target_type = BuiltinEntityType(target.type)
    except (KeyError, TypeError, ValueError) as exc:
        raise HubWikiCacheError("Invalid Hub Wiki target identity") from exc

    hub_target = await hub_get(target_type, target.id)
    if not isinstance(hub_target, dict) or not hub_target.get("id"):
        raise HubWikiCacheError(f"Hub Wiki target not found or unavailable: {target}")
    await materialize_hub_entity(hub_target, owner=owner)

    source = result.get("source")
    if source not in {"entry", "implicit"}:
        raise HubWikiCacheError("Invalid Hub Wiki resolve source")
    return {
        "kind": "resolved",
        "target_typeid": str(target),
        "source": source,
    }
