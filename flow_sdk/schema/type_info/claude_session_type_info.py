"""Type metadata for CLAUDE_SESSION."""
import uuid

from flow_sdk.fs_store.indexer.functions.claude_sessions import (
    claude_session_id_from_file,
    claude_session_stable_key,
    extract_claude_session,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

CLAUDE_SESSION = TypeMetadata(
    type=EntityType.CLAUDE_SESSION,
    indexed_by_default=True,
    from_disk_fn=extract_claude_session,
    id_from_file_fn=claude_session_id_from_file,
    id_stable_key_fn=claude_session_stable_key,
    id_namespace=uuid.NAMESPACE_DNS,
    # Shared ClaudeTranscript: row-only passive payload — staged like every
    # bundle entry, then auto-installed (no review gate). ``received=True``
    # marks it never ran here (not resumable); ``remote=False`` because it has
    # no hub twin of its own.
    receive_policy="auto",
    receive_row_overrides={"remote": False, "received": True},
)
