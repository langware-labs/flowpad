"""Type metadata for MARKDOWN."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.markdown import (
    extract_markdown,
    markdown_gen_id,
)
from flow_sdk.fs_store.operations.markdown import reconcile_folder_doc_edges

MARKDOWN = TypeMetadata(
    type=EntityType.MARKDOWN,
    icon="BookOpen",
    browseable=True,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["title", "tags", "links"],
    main_subdir="docs",
    from_disk_fn=extract_markdown,
    gen_id_fn=markdown_gen_id,
    post_sync_fn=reconcile_folder_doc_edges,
)
