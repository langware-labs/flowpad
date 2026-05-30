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
    from_disk_fn=extract_mcp_server,
    gen_id_fn=mcp_server_id,
)
