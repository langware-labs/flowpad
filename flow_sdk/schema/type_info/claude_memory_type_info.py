"""Type metadata for CLAUDE_MEMORY."""
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    IDENTITY_CAPSULE,
    capsule_identity,
    frontmatter_id,
    resolved_path_key,
)
from flow_sdk.fs_store.indexer.functions.claude_memory import (
    extract_claude_memory,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

CLAUDE_MEMORY = TypeMetadata(
    hub_main_file="document.md",
    type=EntityType.CLAUDE_MEMORY,
    icon="Brain",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name"],
    from_disk_fn=extract_claude_memory,
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(frontmatter_id),
    id_stable_key_fn=resolved_path_key,
)
