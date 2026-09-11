"""Application projection of filesystem asset metadata into public Entity fields."""

from __future__ import annotations

from pathlib import Path

from pydantic import JsonValue

from flow_sdk.assets.git_origin import PortableGitOrigin
from flow_sdk.assets.projection import (
    _LOCAL_OR_RUNTIME_FIELDS,
    PortableAssetProjection,
    layout_for_origin,
    read_asset_tree,
)
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def _portable_fields(entity, entity_cls: type) -> dict[str, JsonValue]:
    excluded = set(entity_cls.fields_not_sent_to_hub()) | set(_LOCAL_OR_RUNTIME_FIELDS)
    computed = set(getattr(entity_cls, "model_computed_fields", {}))
    dumped = entity.model_dump(mode="json", exclude_none=True)
    return {
        key: value
        for key, value in dumped.items()
        if entity_cls.is_api_field(key) and key not in excluded and key not in computed
    }


def project_asset_tree(
    *,
    entity_type: str,
    expected_id: str,
    checkout_root: Path,
    origin: PortableGitOrigin,
) -> PortableAssetProjection:
    """Read filesystem content and apply the public Entity field allowlist."""
    record = read_asset_tree(
        entity_type=entity_type,
        expected_id=expected_id,
        checkout_root=checkout_root,
        origin=origin,
    )
    info = SchemaRegistry.get(entity_type)
    assert info is not None  # read_asset_tree validated the type.
    entity_cls = info.entity_cls or SchemaRegistry.get_entity_cls(entity_type)
    if entity_cls is None:
        import flow_sdk.models.entities  # noqa: F401, PLC0415

        entity_cls = SchemaRegistry.get_entity_cls(entity_type)
    if entity_cls is None:
        raise ValueError(f"type {entity_type!r} has no registered entity model")

    from flow_sdk.core.entity.entity_model import Entity  # noqa: PLC0415

    entity = Entity._build_from_fs_record(record, fallback_cls=entity_cls)
    return PortableAssetProjection(
        type=entity_type,
        id=expected_id,
        fields=_portable_fields(entity, entity_cls),
        layout=layout_for_origin(info, origin),
    )
