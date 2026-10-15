"""Type metadata for OPENCODE_SESSION and DEEPAGENTS_SESSION: sessions of workers that keep
them in a store, so the transcript is FlowPad's own file, snapshotted when shared."""

import uuid

from flow_sdk.assets.identity import derived_identity
from flow_sdk.assets.layout import File
from flow_sdk.assets.types import store_sessions as s
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.types import EntityType


def _store_session(type_name: EntityType, label: str, extract, id_from_file, identity_key) -> TypeInfo:
    return TypeInfo(
        type_name=type_name,
        # Never walked: a row exists only once a share snapshots the run's transcript
        # (AgenticProcess ``session-transcript``).
        indexed_by_default=False,
        api_visible=True,  # see CLAUDE_SESSION
        icon=label,
        display_name=f"{label} Sessions",
        from_disk_fn=extract,
        identity_carrier=derived_identity(id_from_file),
        identity_key_fn=identity_key,
        id_namespace=uuid.NAMESPACE_DNS,
        asset_class="repo",
        family=str(type_name.value),
        shape=File(ext=".jsonl"),
        receive_row_overrides={"remote": False, "received": True},
    )


OPENCODE_SESSION = _store_session(
    EntityType.OPENCODE_SESSION, "OpenCode",
    s.extract_opencode_session, s.opencode_session_id_from_file, s.opencode_session_identity_key,
)
DEEPAGENTS_SESSION = _store_session(
    EntityType.DEEPAGENTS_SESSION, "DeepAgents",
    s.extract_deepagents_session, s.deepagents_session_id_from_file, s.deepagents_session_identity_key,
)
