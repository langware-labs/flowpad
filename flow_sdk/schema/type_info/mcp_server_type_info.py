"""Type metadata for MCP_SERVER."""
import uuid

from flow_sdk.fs_store.indexer.functions._asset_identity import no_id
from flow_sdk.fs_store.indexer.functions.mcp_server import (
    extract_mcp_server,
    mcp_server_identity_key,
)
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType

MCP_SERVER = TypeMetadata(
    type=EntityType.MCP_SERVER,
    icon="Plug",
    indexed_by_default=True,
    api_visible=True,
    # Documented shape for `flow schema info mcp_server`. Search-by-command
    # works via the record's `description` (the FTS-fed launch line); these
    # advertise the structured fields consumers should filter on.
    index_fields=["command", "url", "scope", "worker_type", "connector_type"],
    from_disk_fn=extract_mcp_server,
    id_from_file_fn=no_id,
    id_stable_key_fn=mcp_server_identity_key,
    id_namespace=uuid.NAMESPACE_DNS,
)
