"""Type metadata for COPILOT_SESSION."""

import uuid

from flow_sdk.assets.identity import derived_identity
from flow_sdk.assets.layout import File
from flow_sdk.assets.types.copilot_sessions import (
    copilot_session_id_from_file,
    copilot_session_identity_key,
    extract_copilot_session,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType

COPILOT_SESSION = TypeInfo(
    type_name=EntityType.COPILOT_SESSION,
    indexed_by_default=True,
    api_visible=True,  # see CLAUDE_SESSION
    icon="Copilot",  # see CLAUDE_SESSION
    from_disk_fn=extract_copilot_session,
    identity_carrier=derived_identity(copilot_session_id_from_file),
    identity_key_fn=copilot_session_identity_key,
    id_namespace=uuid.NAMESPACE_DNS,
    # Same contract as CLAUDE_SESSION — see the comment there. Copilot's own store
    # (``~/.copilot/session-state/``) is globbed by ``copilot_sessions_fn``; an
    # installed transcript lands in the repo hierarchy under its own type name.
    asset_class="repo",
    family="copilot_session",
    shape=File(ext=".jsonl"),
    receive_row_overrides={"remote": False, "received": True},
)
