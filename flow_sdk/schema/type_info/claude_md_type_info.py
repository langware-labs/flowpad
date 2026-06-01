"""Type metadata for CLAUDE_MD."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.markdown import extract_markdown, markdown_gen_id

CLAUDE_MD = TypeMetadata(
    type=EntityType.CLAUDE_MD,
    icon="BookOpen",
    api_visible=True,
    from_disk_fn=extract_markdown,
    gen_id_fn=markdown_gen_id,
)
