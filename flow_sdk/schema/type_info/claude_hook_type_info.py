"""Type metadata for CLAUDE_HOOK."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.claude_hook import (
    extract_claude_hook,
    claude_hook_id,
)

CLAUDE_HOOK = TypeMetadata(
    type=EntityType.CLAUDE_HOOK,
    icon="Webhook",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_claude_hook,
    gen_id_fn=claude_hook_id,
)
