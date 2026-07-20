"""Type metadata for MARKDOWN_INDEX."""
from flow_sdk.fs_store.indexer.functions._asset_identity import no_id
from flow_sdk.fs_store.indexer.functions.markdown_index import (
    extract_markdown_index,
    markdown_index_identity_key,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

MARKDOWN_INDEX = TypeMetadata(
    type=EntityType.MARKDOWN_INDEX,
    from_disk_fn=extract_markdown_index,
    id_from_file_fn=no_id,
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
    asset_class="internal",
    family="docs",
)
