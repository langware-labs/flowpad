"""Type metadata for CLAUDE_SESSION."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    claude_session_id,
    extract_claude_session,
)

CLAUDE_SESSION = TypeMetadata(
    type=EntityType.CLAUDE_SESSION,
    indexed_by_default=True,
    from_disk_fn=extract_claude_session,
    gen_id_fn=claude_session_id,
)
