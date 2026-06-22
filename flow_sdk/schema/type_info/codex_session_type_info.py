"""Type metadata for CODEX_SESSION."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.codex_sessions import (
    extract_codex_session,
    codex_session_id,
)

CODEX_SESSION = TypeMetadata(
    type=EntityType.CODEX_SESSION,
    indexed_by_default=True,
    from_disk_fn=extract_codex_session,
    gen_uuid_fn=codex_session_id,
)
