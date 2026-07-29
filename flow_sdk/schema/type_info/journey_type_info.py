"""Type metadata for JOURNEY — folder-backed guided-onboarding document."""
from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, capsule_identity, folder_capsule_id
from flow_sdk.fs_store.indexer.functions.journey import (
    extract_journey,
    journey_asset_hash,
    journey_id_from_folder,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

JOURNEY = TypeMetadata(
    type=EntityType.JOURNEY,
    icon="Compass",
    displayName="Journeys",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="journey",
    main_layout="folder",
    main_file="graph.json",
    from_disk_fn=extract_journey,
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(folder_capsule_id, journey_id_from_folder),
    asset_hash_fn=journey_asset_hash,
)
