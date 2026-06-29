"""Type metadata for MARKDOWN_INDEX."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.markdown_index import (
    extract_markdown_index,
    markdown_index_gen_id,
)

MARKDOWN_INDEX = TypeMetadata(
    type=EntityType.MARKDOWN_INDEX,
    from_disk_fn=extract_markdown_index,
    gen_uuid_fn=markdown_index_gen_id,
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
    main_subdir="docs",
)
