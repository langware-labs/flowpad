"""Type metadata for COPILOT_SESSION."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.copilot_sessions import (
    extract_copilot_session,
    copilot_session_id,
)

COPILOT_SESSION = TypeMetadata(
    type=EntityType.COPILOT_SESSION,
    indexed_by_default=True,
    from_disk_fn=extract_copilot_session,
    gen_id_fn=copilot_session_id,
)
