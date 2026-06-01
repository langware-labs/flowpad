"""Type metadata for PLUGIN."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.plugin import (
    extract_plugin,
    plugin_id,
)

PLUGIN = TypeMetadata(
    type=EntityType.PLUGIN,
    icon="Plug",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_plugin,
    gen_id_fn=plugin_id,
)
