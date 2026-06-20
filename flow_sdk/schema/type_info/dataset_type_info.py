"""Type metadata for DATASET."""
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.dataset import (
    dataset_asset_hash,
    dataset_gen_id,
    extract_dataset,
)


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
    main_subdir="assets/datasets",
    main_layout="folder",
    from_disk_fn=extract_dataset,
    gen_id_fn=dataset_gen_id,
    asset_hash_fn=dataset_asset_hash,
    meta_model=DatasetMeta,
)
