"""Type metadata for JOURNEY — folder-backed guided-onboarding document."""
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    IDENTITY_CAPSULE,
    folder_capsule_id,
    folder_json_identity,
)
from flow_sdk.fs_store.indexer.functions.journey import (
    extract_journey,
    journey_asset_hash,
    journey_id_from_folder,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

JOURNEY = TypeInfo(
    type_name=EntityType.JOURNEY,
    icon="Compass",
    display_name="Journeys",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="journey",
    shape=Folder(main="graph.json"),
    editor="journey",
    from_disk_fn=extract_journey,
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=folder_json_identity(folder_capsule_id, journey_id_from_folder),
    asset_hash_fn=journey_asset_hash,
)
