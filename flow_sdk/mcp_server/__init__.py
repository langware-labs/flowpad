"""flow_sdk.mcp — MCP server with flow tools."""

from fastmcp import FastMCP

from flow_sdk.mcp_server.context_store import ContextStore
from flow_sdk.mcp_server.mcp_api import (
    flow_context,
    flow_entity_crud,
    flow_ping,
    flow_tag,
    session_analysis,
    # workflow_trace,  # disabled — not needed for current flow
)

# Singleton stores used by flow_context tool
session_store = ContextStore()
known_rules_store = ContextStore()

mcp = FastMCP("flow_sdk")

mcp.tool()(flow_ping)
mcp.tool()(flow_entity_crud)
mcp.tool()(flow_tag)
mcp.tool()(flow_context)
mcp.tool()(session_analysis)
# mcp.tool()(workflow_trace)  # disabled — not needed for current flow


def run():
    mcp.run(transport="stdio", show_banner=False)
