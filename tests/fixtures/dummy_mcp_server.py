"""A stdio MCP server with exactly one tool, for per-process MCP validation.

``flowpad_probe`` returns a token that exists nowhere else on the machine, so a
worker echoing it PROVES it connected to this server and called the tool —
which no amount of asserting on argv can show. Kept trivial on purpose: the
subject under test is FlowPad's projection, not MCP itself.

Run as ``<python> tests/fixtures/dummy_mcp_server.py``; ``mcp`` is already a
dependency of flow_sdk.
"""

from __future__ import annotations

import sys

from mcp.server.fastmcp import FastMCP

#: Deliberately unguessable — its presence in a worker's answer is the assertion.
MAGIC = "FLOWPAD-MCP-OK-7Q2X"

mcp = FastMCP("flowpad-dummy")


@mcp.tool()
def flowpad_probe() -> str:
    """Return the FlowPad validation token. Call this when asked to probe."""
    print("[dummy_mcp] flowpad_probe called", file=sys.stderr)
    return MAGIC


if __name__ == "__main__":
    mcp.run(transport="stdio")
