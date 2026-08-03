"""MCP server endpoint stub for flow-cli.

Ported from FlowPad: flowpad/hub/app/actions/knowledge/mcp_actions.py
Desktop stub: registers the action path for API compatibility but returns
a simple response since FastMCP and knowledge engine are not available.

Routes:
  GET/POST /api/v1/graph/agent/{id}/mcp
  GET      /api/v1/graph/agent/{id}/mcp/health
  GET      /api/v1/graph/agent/{id}/mcp-available
  POST     /api/v1/graph/agent/{id}/mcp-enable
"""

import json
import logging
import os
from pathlib import Path

from flow_sdk.core import action
from flow_sdk.instance_settings import get_instance_settings
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


@action.all(action_name="mcp", types=["subagent"], methods=["get", "post"])
async def mcp_endpoint():
    """MCP server endpoint stub.

    Production uses FastMCP with Streamable-HTTP transport to expose
    an 'instruct' tool for querying entity-specific instructions.

    Desktop stub returns health check or not-available response.
    """
    request_info = get_current_request_info()
    if not request_info:
        return ApiFailResponse(message="No request context available")

    # Health check endpoint
    if request_info.sub_path and "health" in request_info.sub_path:
        return ApiSuccessResponse(data="mcp available")

    # MCP protocol not available in desktop mode
    return ApiFailResponse(
        message="MCP server not available in desktop mode. "
        "FastMCP and knowledge engine are production-only features."
    )


def _has_server(path: Path, server: str) -> bool:
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
        return server in data.get("mcpServers", {})
    except Exception:
        return False


@action.get(action_name="mcp-available", types=["compute_node"])
async def mcp_available():
    """Check if an MCP server is configured at user or project scope.

    Query param: server (default: flow-sdk-mcp)
    """
    request_info = get_current_request_info()
    server = "flow-sdk-mcp"
    if request_info and request_info.request_parameters:
        server = request_info.request_parameters.get("server", server)

    user_path = get_instance_settings().claude_mcp_json_path
    cwd = Path(os.getcwd())
    project_paths = [cwd / ".mcp.json", cwd / ".claude" / "mcp.json"]

    user_scope = _has_server(user_path, server)
    project_scope = any(_has_server(p, server) for p in project_paths)

    return ApiSuccessResponse(data={
        "available": user_scope or project_scope,
        "user_scope": user_scope,
        "project_scope": project_scope,
    })


@action.post(action_name="mcp-enable", types=["compute_node"])
async def mcp_enable():
    """Add an MCP server to user or project .mcp.json.

    Body params: server (default: flow-sdk-mcp), scope (user|project)
    """
    request_info = get_current_request_info()
    server = "flow-sdk-mcp"
    scope = "user"
    if request_info and request_info.request_parameters:
        server = request_info.request_parameters.get("server", server)
        scope = request_info.request_parameters.get("scope", scope)

    entry = {"type": "stdio", "command": server, "args": []}

    if scope == "user":
        target = get_instance_settings().claude_mcp_json_path
    elif scope == "project":
        target = Path(os.getcwd()) / ".mcp.json"
    else:
        return ApiFailResponse(message=f"Invalid scope: {scope}. Must be 'user' or 'project'.")

    try:
        data = json.loads(target.read_text()) if target.exists() else {}
        data.setdefault("mcpServers", {})[server] = entry
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, indent=2))
        return ApiSuccessResponse(data={"enabled": True, "path": str(target)})
    except Exception as e:
        return ApiFailResponse(message=f"Failed to write {target}: {e}")
