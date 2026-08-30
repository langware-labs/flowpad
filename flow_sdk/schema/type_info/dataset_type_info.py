"""Type metadata for DATASET."""
from flow_sdk.builtin.dataset import DatasetManifestSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    IDENTITY_CAPSULE,
    folder_capsule_id,
    folder_json_identity,
)
from flow_sdk.fs_store.indexer.functions.dataset import (
    dataset_asset_hash,
    dataset_id_from_folder,
    derive_dataset,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

DATASET = TypeMetadata(
    type=EntityType.DATASET,
    icon="Database",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description", "source_id"],
    asset_class="repo",
    family="dataset",
    main_layout="folder",
    # The manifest that marks a folder as a dataset — also the repo walker's
    # marker gate (a dataset folder must carry it). asset_ref stays the folder
    # (main_file_is_asset_ref unset), so this only names the marker/body file.
    main_file="dataset.json",
    rows_layout_field="data_layout",
    derive_fields_fn=derive_dataset,
    asset_spec=DatasetManifestSpec,
    fts_content=("title", "description"),
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=folder_json_identity(folder_capsule_id, dataset_id_from_folder),
    asset_hash_fn=dataset_asset_hash,
)
