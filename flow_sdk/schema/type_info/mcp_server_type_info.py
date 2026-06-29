"""Type metadata for MCP_SERVER."""
from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store.indexer.functions.mcp_server import (
    extract_mcp_server,
    mcp_server_id,
)

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
    gen_uuid_fn=mcp_server_id,
)
