"""Type metadata for PLUGIN."""
import uuid

from flow_sdk.fs_store.indexer.functions.plugin import (
    extract_plugin,
    plugin_id_from_file,
    plugin_stable_key,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

PLUGIN = TypeMetadata(
    type=EntityType.PLUGIN,
    icon="Plug",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_plugin,
    id_from_file_fn=plugin_id_from_file,
    id_stable_key_fn=plugin_stable_key,
    id_namespace=uuid.NAMESPACE_DNS,
)
