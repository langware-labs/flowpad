"""Type metadata for WHITEBOARD."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.whiteboard import (
    extract_whiteboard,
    whiteboard_asset_hash,
    whiteboard_gen_id,
)

WHITEBOARD = TypeMetadata(
    type=EntityType.WHITEBOARD,
    icon="Palette",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    main_subdir=".claude/whiteboards",
    main_layout="folder",
    from_disk_fn=extract_whiteboard,
    gen_uuid_fn=whiteboard_gen_id,
    asset_hash_fn=whiteboard_asset_hash,
)
