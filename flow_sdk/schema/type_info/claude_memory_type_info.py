"""Type metadata for CLAUDE_MEMORY."""
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    IDENTITY_CAPSULE,
    frontmatter_identity,
    resolved_path_key,
)
from flow_sdk.fs_store.indexer.functions.claude_memory import (
    extract_claude_memory,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

CLAUDE_MEMORY = TypeInfo(
    hub_main_file="document.md",
    type_name=EntityType.CLAUDE_MEMORY,
    shape=File(ext=".md"),
    editor="markdown",
    icon="Brain",
    browseable_by=ViewMode.ADVANCED,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["name"],
    from_disk_fn=extract_claude_memory,
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=frontmatter_identity(),
    id_stable_key_fn=resolved_path_key,
)
