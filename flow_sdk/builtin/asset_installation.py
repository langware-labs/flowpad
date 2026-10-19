"""Application indexing after filesystem installation has succeeded."""
from __future__ import annotations

from flow_sdk.assets.asset import Asset
from flow_sdk.assets.placement import Scope


async def index_installed_asset(source: Asset, installed: Asset, *, scope: Scope,
                                project_id: str | None = None) -> None:
    """Apply the existing index collision policy, preserving occurrence history."""
    from flow_sdk.fs_store.asset_occurrences import resolved_collision
    from flow_sdk.fs_store.resolve import index_one, resolve_asset
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    ref = installed.typeid
    entity_cls = SchemaRegistry.get_entity_cls(ref.type)
    incumbent = await entity_cls.get_one({"id": ref.id}) if entity_cls else None
    original = await resolve_asset(source.path, write=False, type_name=ref.type, owner_id=ref.id)
    resolved = await resolve_asset(installed.path, write=False, type_name=ref.type, owner_id=ref.id)
    decision = await resolved_collision(ref.type, ref.id, incumbent, [original, resolved])
    if decision is None:
        raise LookupError(f"no collision decision for {ref}")
    primary = resolved if decision.primary_path == str(resolved.root) else await resolve_asset(
        decision.primary_path, write=False, type_name=ref.type, owner_id=ref.id)
    if primary.root == resolved.root:
        await index_one(primary, notify=True, scope=scope, project_id=project_id)
    else:
        await index_one(primary, notify=True)
    entity = await entity_cls.get_one({"id": ref.id}) if entity_cls else None
    if entity is not None:
        await entity.reflect_asset_occurrences(decision.occurrences, notify=True)
