"""Type metadata for CLAUDE_MEMORY."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.claude_memory import (
    extract_claude_memory,
    claude_memory_gen_id,
)

CLAUDE_MEMORY = TypeMetadata(
    type=EntityType.CLAUDE_MEMORY,
    icon="Brain",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name"],
    from_disk_fn=extract_claude_memory,
    gen_id_fn=claude_memory_gen_id,
)
