"""Type metadata for COPILOT_SESSION."""

import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.copilot_sessions import (
    copilot_session_id_from_file,
    copilot_session_stable_key,
    extract_copilot_session,
)
from flow_sdk.fs_store.placement import TRANSCRIPTS_FAMILY
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

COPILOT_SESSION = TypeMetadata(
    type=EntityType.COPILOT_SESSION,
    indexed_by_default=True,
    api_visible=True,  # see CLAUDE_SESSION
    icon="Copilot",  # see CLAUDE_SESSION
    from_disk_fn=extract_copilot_session,
    identity_backend=derived_identity(copilot_session_id_from_file),
    id_stable_key_fn=copilot_session_stable_key,
    id_namespace=uuid.NAMESPACE_DNS,
    # Same contract as CLAUDE_SESSION — see the comment there. ``copilot`` maps
    # onto the ``.github`` prefix (shared with the github harness, pre-existing).
    asset_class="harness",
    harness="copilot",
    family=TRANSCRIPTS_FAMILY,
    main_layout="file",
    main_ext=".jsonl",
    receive_row_overrides={"remote": False, "received": True},
)
