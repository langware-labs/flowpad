"""Type metadata for WHITEBOARD."""
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    frontmatter_identity,
)
from flow_sdk.fs_store.indexer.functions.whiteboard import (
    extract_whiteboard,
    whiteboard_asset_hash,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

WHITEBOARD = TypeInfo(
    type_name=EntityType.WHITEBOARD,
    icon="Palette",
    display_name="Whiteboards",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="whiteboard",
    # The folder's main doc — drives the share id-pin (``Folder.main``) and
    # stabilizes asset_ref/hash (without it asset_ref was the bare folder and the
    # index hash oscillated, making receive intermittent).
    shape=Folder(main="WHITE_BOARD.md"),
    editor="whiteboard",
    from_disk_fn=extract_whiteboard,
    identity_carrier=frontmatter_identity(),
    asset_hash_fn=whiteboard_asset_hash,
)
