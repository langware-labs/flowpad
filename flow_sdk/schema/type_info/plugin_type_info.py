"""Type metadata for PLUGIN."""
import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import derived_identity
from flow_sdk.fs_store.indexer.functions.plugin import (
    extract_plugin,
    plugin_id_from_file,
    plugin_identity_key,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

PLUGIN = TypeMetadata(
    type=EntityType.PLUGIN,
    icon="Plug",
    indexed_by_default=True,
    api_visible=True,
    from_disk_fn=extract_plugin,
    identity_carrier=derived_identity(plugin_id_from_file),
    identity_key_fn=plugin_identity_key,
    id_namespace=uuid.NAMESPACE_DNS,
)
