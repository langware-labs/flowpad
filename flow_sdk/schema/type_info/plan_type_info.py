"""Type metadata for PLAN."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.claude_plan import (
    claude_plan_gen_id,
    extract_claude_plan,
)

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
    gen_uuid_fn=claude_plan_gen_id,
)
