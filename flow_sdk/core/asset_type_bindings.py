"""Bind application observers to the existing filesystem type declarations."""
from flow_sdk.fs_store.schema_registry import SchemaRegistry, TypeInfo
from flow_sdk.schema.types import EntityType

_bound_state = None

def register_asset_runtime_bindings() -> None:
    global _bound_state
    SchemaRegistry._ensure_loaded()
    state = (SchemaRegistry._registry_generation, tuple(id(info) for info in SchemaRegistry._types.values()))
    if _bound_state == state:
        return
    from flow_sdk.builtin.trigger_arming import arm_after_index
    from flow_sdk.fs_store.operations.markdown import reconcile_folder_doc_edges
    from flow_sdk.fs_store.operations.project_manifest import reconcile_published_cache
    from flow_sdk.rag.observer import mark_rag_stale

    SchemaRegistry._ensure_loaded()
    for name, hooks in (
        (EntityType.MARKDOWN, (reconcile_folder_doc_edges, mark_rag_stale)),
        (EntityType.PROJECT_MANIFEST, reconcile_published_cache),
        (EntityType.TRIGGER, arm_after_index),
    ):
        SchemaRegistry.register(TypeInfo(type_name=name, post_sync_fn=hooks))
    from flow_sdk.assets.identity import derived_identity
    from flow_sdk.fs_store.indexer.functions.claude_projects import (
        claude_project_identity_key,
        existing_project_record_id,
        extract_claude_project,
    )
    project = SchemaRegistry.get(EntityType.PROJECT)
    project.identity_carrier = derived_identity(existing_project_record_id)
    project.id_stable_key_fn = claude_project_identity_key
    project.from_disk_fn = extract_claude_project
    from flow_sdk.fs_store.indexer.functions.markdown import derive_markdown_context
    for type_name in (EntityType.MARKDOWN, EntityType.CLAUDE_MD):
        SchemaRegistry.get(type_name).row_derive_fn = derive_markdown_context
    SchemaRegistry.check_asset_specs()
    _bound_state = (SchemaRegistry._registry_generation, tuple(id(info) for info in SchemaRegistry._types.values()))


def compose_asset_row_defaults(type_name: str, entity_cls: type, data: dict) -> None:
    """A complete filesystem snapshot resets omitted authored fields on a row.

    Pure records retain only file-owned data. Defaults belong to the Entity
    adapter, and DB-owned facts absent from a file never receive a reset.
    """
    if not data.get("asset_ref"):
        return
    info = SchemaRegistry.get(type_name)
    if info is None or info.asset_spec is None:
        return
    from flow_sdk.api.api_types.api_field import Persist, persist_policy

    blob_fields = set(entity_cls.get_blob_fields_names())
    for name in info.asset_spec.model_fields:
        field = entity_cls.model_fields.get(name)
        if name in data or name in blob_fields or field is None or field.is_required() or persist_policy(field) == Persist.TRUE:
            continue
        data[name] = field.get_default(call_default_factory=True, validated_data=data)
