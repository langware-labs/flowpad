"""Type metadata for DATASET."""
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import write_folder_capsule
from flow_sdk.fs_store.indexer.functions.dataset import (
    dataset_asset_hash,
    dataset_id_from_folder,
    extract_dataset,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode


class DatasetMeta(BaseMeta):
    data_layout: Optional[str] = None
    field_spec: Optional[dict] = None
    delimiter: Optional[str] = None
    num_examples: Optional[int] = None
    kind_counts: Optional[dict] = None
    num_annotated: Optional[int] = None
    num_multi_output: Optional[int] = None
    num_binary_inputs: Optional[int] = None


DATASET = TypeMetadata(
    type=EntityType.DATASET,
    icon="Database",
    browseable_by=ViewMode.ADVANCED,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description"],
    asset_class="repo",
    family="dataset",
    main_layout="folder",
    # The manifest that marks a folder as a dataset — also the repo walker's
    # marker gate (a dataset folder must carry it). asset_ref stays the folder
    # (main_file_is_asset_ref unset), so this only names the marker/body file.
    main_file="dataset.json",
    from_disk_fn=extract_dataset,
    id_from_folder_fn=dataset_id_from_folder,
    id_write_fn=write_folder_capsule,
    asset_hash_fn=dataset_asset_hash,
    meta_model=DatasetMeta,
)
