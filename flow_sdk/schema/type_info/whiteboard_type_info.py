"""Type metadata for WHITEBOARD."""
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, folder_md_identity
from flow_sdk.fs_store.indexer.functions.whiteboard import (
    extract_whiteboard,
    whiteboard_asset_hash,
    whiteboard_id_from_folder,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

WHITEBOARD = TypeMetadata(
    type=EntityType.WHITEBOARD,
    icon="Palette",
    displayName="Whiteboards",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="whiteboard",
    main_layout="folder",
    # The folder's main doc — drives the share id-pin (TypeInfo.main_file) and
    # stabilizes asset_ref/hash (without it asset_ref was the bare folder and the
    # index hash oscillated, making receive intermittent).
    main_file="WHITE_BOARD.md",
    from_disk_fn=extract_whiteboard,
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=folder_md_identity(whiteboard_id_from_folder),
    asset_hash_fn=whiteboard_asset_hash,
)
