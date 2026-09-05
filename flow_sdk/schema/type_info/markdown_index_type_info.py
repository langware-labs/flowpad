"""Type metadata for MARKDOWN_INDEX."""
from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.markdown_index import (
    extract_markdown_index,
    markdown_index_identity_key,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import File
from flow_sdk.schema.types import EntityType

MARKDOWN_INDEX = TypeInfo(
    type_name=EntityType.MARKDOWN_INDEX,
    shape=File(ext=".md"),
    from_disk_fn=extract_markdown_index,
    identity_carrier=derived_identity(),
    id_stable_key_fn=markdown_index_identity_key,
    indexed_by_default=False,
    creatable=True,
    api_visible=True,
    icon="ListTree",
    index_fields=[
        "title",
        "parent_ref",
        "inputs_hash",
        "vault_root",
        "parent_path",
    ],
    asset_class="docs",
    family="docs",
)
