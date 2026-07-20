"""Type metadata for COPILOT_SESSION."""
import uuid

from flow_sdk.fs_store.indexer.functions.copilot_sessions import (
    copilot_session_id_from_file,
    copilot_session_stable_key,
    extract_copilot_session,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

COPILOT_SESSION = TypeMetadata(
    type=EntityType.COPILOT_SESSION,
    indexed_by_default=True,
    from_disk_fn=extract_copilot_session,
    id_from_file_fn=copilot_session_id_from_file,
    id_stable_key_fn=copilot_session_stable_key,
    id_namespace=uuid.NAMESPACE_DNS,
)
