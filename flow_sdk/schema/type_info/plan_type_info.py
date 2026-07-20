"""Type metadata for PLAN."""
from flow_sdk.fs_store.indexer.functions._asset_identity import frontmatter_id, resolved_path_key, write_frontmatter
from flow_sdk.fs_store.indexer.functions.claude_plan import extract_claude_plan
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

PLAN = TypeMetadata(
    type=EntityType.PLAN,
    icon="FileText",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name"],
    asset_class="harness",
    harness="claude",
    family="plans",
    from_disk_fn=extract_claude_plan,
    id_from_file_fn=frontmatter_id,
    id_stable_key_fn=resolved_path_key,
    id_write_fn=write_frontmatter,
)
