"""Type metadata for CLAUDE_RULES."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.claude_rules import (
    claude_rules_gen_id,
    extract_claude_rules,
)

CLAUDE_RULES = TypeMetadata(
    type=EntityType.CLAUDE_RULES,
    icon="Shield",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name"],
    from_disk_fn=extract_claude_rules,
    gen_uuid_fn=claude_rules_gen_id,
)
