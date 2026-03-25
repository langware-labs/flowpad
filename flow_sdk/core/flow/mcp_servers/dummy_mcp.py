from fastmcp import Context
from mcp_auth import create_mcp_server

# Create an MCP server
mcp = create_mcp_server("DummyMCP")


@mcp.tool()
async def foo(ctx: Context) -> str:
    """Dummy tool that returns 'bar'."""
    return "bar"
