"""Type metadata for CODEX_SESSION."""

import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
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
    identity_backend=derived_identity(codex_session_id_from_file),
    id_stable_key_fn=codex_session_stable_key,
    id_namespace=uuid.NAMESPACE_DNS,
    # Same contract as CLAUDE_SESSION — see the comment there. Only the harness
    # differs, and nothing downstream branches on the worker. NOTE the value is
    # ``agents``, not ``codex``: ``_WORKER_NAME_TO_TYPE`` maps codex onto the
    # ``.agents`` standard, and ``effective_harness`` does NOT coerce — an
    # unrecognized string silently falls back to ``.claude/``.
    asset_class="harness",
    harness="agents",
    family="transcripts",
    main_layout="file",
    main_ext=".jsonl",
    receive_row_overrides={"remote": False, "received": True},
)
