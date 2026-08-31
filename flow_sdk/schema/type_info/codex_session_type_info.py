"""Type metadata for CODEX_SESSION."""

import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.codex_sessions import (
    codex_session_id_from_file,
    codex_session_identity_key,
    extract_codex_session,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

CODEX_SESSION = TypeMetadata(
    type=EntityType.CODEX_SESSION,
    indexed_by_default=True,
    api_visible=True,  # see CLAUDE_SESSION
    icon="Codex",  # see CLAUDE_SESSION
    from_disk_fn=extract_codex_session,
    identity_carrier=derived_identity(codex_session_id_from_file),
    identity_key_fn=codex_session_identity_key,
    id_namespace=uuid.NAMESPACE_DNS,
    # Same contract as CLAUDE_SESSION — see the comment there. Codex's own store
    # (``~/.codex/sessions/``) is globbed by ``codex_sessions_fn``; an installed
    # transcript lands in the repo hierarchy under its own type name.
    asset_class="repo",
    family="codex_session",
    main_layout="file",
    main_ext=".jsonl",
    receive_row_overrides={"remote": False, "received": True},
)
