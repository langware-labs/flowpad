"""Type metadata for COMMAND."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.claude_command import (
    extract_claude_command,
    command_gen_id,
)

COMMAND = TypeMetadata(
    type=EntityType.COMMAND,
    icon="Terminal",
    indexed_by_default=True,
    api_visible=True,
    asset_class="harness",
    harness="claude",
    family="commands",
    from_disk_fn=extract_claude_command,
    gen_uuid_fn=command_gen_id,
)
