"""Type metadata for CODEX_SESSION."""
import uuid

from flow_sdk.fs_store.indexer.functions.codex_sessions import (
    codex_session_id_from_file,
    codex_session_stable_key,
    extract_codex_session,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

CODEX_SESSION = TypeMetadata(
    type=EntityType.CODEX_SESSION,
    indexed_by_default=True,
    from_disk_fn=extract_codex_session,
    id_from_file_fn=codex_session_id_from_file,
    id_stable_key_fn=codex_session_stable_key,
    id_namespace=uuid.NAMESPACE_DNS,
)
