"""Allow `python -m flow_sdk.mcp_server` to start the server.

Use `python -m flow_sdk.mcp_server --debug` for the raw protocol version (no fastmcp).
"""
import sys

if "--debug" in sys.argv:
    from flow_sdk.mcp_server.debug import run
else:
    from flow_sdk.mcp_server import run

run()
