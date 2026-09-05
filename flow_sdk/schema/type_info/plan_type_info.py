"""Type metadata for PLAN."""
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    IDENTITY_CAPSULE,
    frontmatter_identity,
    resolved_path_key,
)
from flow_sdk.fs_store.indexer.functions.claude_plan import extract_claude_plan
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

PLAN = TypeInfo(
    type_name=EntityType.PLAN,
    shape=File(ext=".md"),
    editor="markdown",
    icon="FileText",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name"],
    asset_class="repo",
    family="plan",
    from_disk_fn=extract_claude_plan,
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=frontmatter_identity(),
    id_stable_key_fn=resolved_path_key,
)
